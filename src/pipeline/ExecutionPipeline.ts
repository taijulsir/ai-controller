import { randomUUID } from "node:crypto";
import type { IExecutionCoordinator } from "../coordination/interfaces";
import type { CapabilityProgram, CapabilityStep } from "../coordination/types";
import type { IControllerCore } from "../controller/interfaces";
import type { ExecutionRequest, ExecutionResult } from "../controller/types";
import type { IRepositoryIntelligenceService } from "../intelligence/interfaces";
import type { Task } from "../planner/types";
import type { IPlanningEngine } from "../planning/interfaces";
import type { IExecutionStrategyEngine } from "../strategy/interfaces";
import type { IExecutionPipeline } from "./interfaces";
import type { PipelineContext, PipelineRequest, PipelineResult, PipelineStepOutcome } from "./types";

// Task types whose StrategyEngine recommendation would misrepresent a
// standalone command's narrow scope: all three collapse into "ShipChanges"
// under StrategyEngine's task-type cascade (built to judge an integrated
// delivery intent), so a bare "/push" would otherwise attempt the entire
// ship workflow instead of just pushing. Bypass-eligible tasks still enter
// exclusively through this pipeline and still reach ControllerCore only
// through it — they just skip Strategy/Planning/Coordination for a question
// that was never in doubt.
const BYPASS_TASK_TYPES: ReadonlySet<Task["type"]> = new Set(["create-commit", "push-changes", "create-pull-request"]);

// A step's translation into real work: either a ready ExecutionRequest, a
// structural gap (no capability exists at all — BranchManagement,
// HumanReview), or a data gap (the capability exists but this step is
// missing something it needs, e.g. a commit message).
type DispatchDecision =
  | { kind: "request"; request: ExecutionRequest }
  | { kind: "blocked"; explanation: string; recommendedAction: string }
  | { kind: "skipped"; reason: string };

// Orchestrates the full autonomous decision flow — Task -> PipelineContext ->
// TaskExecutionStrategy -> ExecutionPlan -> CapabilityProgram -> ControllerCore
// — and is the only module in this stack with a real runtime dependency on
// IControllerCore. It never performs a Git or Claude operation itself, and
// every dispatched step (whether through the full decision stack or the
// bypass path) goes through the exact same IControllerCore instance every
// other front-end uses, so ApprovalEngine and WorkflowOrchestrator apply
// exactly as they always do — nothing here duplicates or bypasses either.
// This is the single runtime entrypoint every front-end (Telegram today)
// submits engineering task execution requests to; ControllerCore remains the
// only thing that actually executes a Task or a workflow.
export class ExecutionPipeline implements IExecutionPipeline {
  constructor(
    private readonly repositoryIntelligence: IRepositoryIntelligenceService,
    private readonly strategyEngine: IExecutionStrategyEngine,
    private readonly planningEngine: IPlanningEngine,
    private readonly executionCoordinator: IExecutionCoordinator,
    private readonly controllerCore: IControllerCore,
  ) {}

  async run(request: PipelineRequest): Promise<PipelineResult> {
    const task = this.resolveTask(request);
    const context = await this.buildContext(request.repositoryId, task);
    const correlationId = request.correlationId ?? randomUUID();

    // Bypass eligibility only ever applies to a literal "task" request whose
    // type is one of the three — never to "pipeline", even though the Task
    // synthesized below for it is create-commit (also bypass eligible as a
    // literal request). The request kind is what disambiguates "/commit"
    // from "/ship", not the shape of the Task either produces.
    if (request.kind === "task" && BYPASS_TASK_TYPES.has(task.type)) {
      return this.runBypass(context, correlationId);
    }

    const strategy = await this.strategyEngine.recommend({ task: context.task, repository: context.repository });
    const plan = this.planningEngine.buildPlan({ task: context.task, strategy, repository: context.repository });
    const program = this.executionCoordinator.buildProgram(plan);

    const stepOutcomes = await this.dispatch(program, correlationId);

    return {
      path: "full",
      context,
      strategy,
      plan,
      program,
      stepOutcomes,
      completed:
        stepOutcomes.length === program.steps.length && stepOutcomes.every((outcome) => outcome.status === "executed"),
    };
  }

  // "pipeline" requests carry no Task at all — this is the one place that
  // synthesizes one (create-commit, carrying the same message), so
  // StrategyEngine/PlanningEngine have something concrete to reason about.
  // For "/ship" today, that happens to reproduce the same operation it
  // dispatched directly before this pipeline existed: StrategyEngine's own
  // cascade recognizes create-commit as shipping intent, and PlanningEngine
  // captures this same message as deliveryInput, so the eventual dispatch is
  // the same "ship" workflow call — but nothing here is coupled to that
  // being the only possible outcome of a "pipeline" request.
  private resolveTask(request: PipelineRequest): Task {
    if (request.kind === "task") {
      return request.task;
    }
    return { type: "create-commit", input: { message: request.message } };
  }

  // The single repository lookup for the entire pipeline run. Every later
  // stage (StrategyEngine, and transitively DecisionEngine/ContextBuilder,
  // then PlanningEngine) reads this same RepositorySnapshot instead of
  // fetching its own — that guarantee is exactly what PipelineContext exists
  // to provide.
  private async buildContext(repositoryId: string | undefined, task: Task): Promise<PipelineContext> {
    const repository = await this.repositoryIntelligence.getSnapshot(repositoryId);
    return { task, repositoryId: repository.repository.id, repository, generatedAt: new Date() };
  }

  private async runBypass(context: PipelineContext, correlationId: string): Promise<PipelineResult> {
    const request: ExecutionRequest = {
      kind: "task",
      task: context.task,
      repositoryId: context.repositoryId,
      correlationId,
    };
    const result = await this.controllerCore.execute(request);
    return { path: "bypass", context, request, result, completed: this.succeeded(result) };
  }

  // Sequential, abort-on-first-failure-or-gap dispatch, mirroring
  // WorkflowOrchestrator's own sequential semantics for its steps — this
  // applies the same simple rule at the pipeline level, it doesn't add new
  // retry/recovery policy of its own. A "blocked" or "skipped" step is
  // exactly as final as a failure: nothing after it runs.
  private async dispatch(program: CapabilityProgram, correlationId: string): Promise<PipelineStepOutcome[]> {
    const outcomes: PipelineStepOutcome[] = [];

    for (const step of program.steps) {
      const decision = this.resolveDispatch(step, program, correlationId);

      if (decision.kind === "blocked") {
        outcomes.push({
          status: "blocked",
          capability: step.capability,
          explanation: decision.explanation,
          recommendedAction: decision.recommendedAction,
        });
        break;
      }
      if (decision.kind === "skipped") {
        outcomes.push({ status: "skipped", capability: step.capability, reason: decision.reason });
        break;
      }

      const result = await this.controllerCore.execute(decision.request);
      outcomes.push({ status: "executed", capability: step.capability, request: decision.request, result });

      if (!this.succeeded(result)) {
        break;
      }
    }

    return outcomes;
  }

  // The one place a Capability is translated into real work. For
  // IntegratedDelivery specifically, this only ever *relays*
  // step.deliveryInput — captured once by PlanningEngine, carried forward
  // unchanged by ExecutionCoordinator — into the shape ExecutionRequest's
  // workflow variant expects; it never inspects plan.task or reconstructs a
  // message/title itself. VerifyRepository dispatches plan.task verbatim,
  // not a hardcoded verify-git-status: its only producer (the AnalyzeFirst
  // recommendation) guarantees plan.task is always one of the four safe,
  // read-only task types this capability covers, so the user's actual
  // request — analyze, explain, or list-prs — is what actually runs.
  private resolveDispatch(step: CapabilityStep, program: CapabilityProgram, correlationId: string): DispatchDecision {
    const { repositoryId, plan } = program;

    switch (step.capability) {
      case "VerifyRepository":
        return { kind: "request", request: { kind: "task", task: plan.task, repositoryId, correlationId } };
      case "ContinueImplementation":
        return { kind: "request", request: { kind: "task", task: plan.task, repositoryId, correlationId } };
      case "PublishRepository":
        return {
          kind: "request",
          request: { kind: "task", task: { type: "push-changes" }, repositoryId, correlationId },
        };
      case "RequestIntegration":
        return plan.task.type === "create-pull-request"
          ? { kind: "request", request: { kind: "task", task: plan.task, repositoryId, correlationId } }
          : { kind: "skipped", reason: "create-pull-request requires a title, which the originating task did not carry." };
      case "IntegratedDelivery":
        return step.deliveryInput
          ? {
              kind: "request",
              request: {
                kind: "workflow",
                workflowId: "ship",
                input: {
                  message: step.deliveryInput.message,
                  body: step.deliveryInput.body,
                  baseBranch: step.deliveryInput.baseBranch,
                },
                repositoryId,
                correlationId,
              },
            }
          : {
              kind: "skipped",
              reason: "The ship workflow requires a commit message or pull request title that the originating task does not carry.",
            };
      case "HumanReview":
        return {
          kind: "blocked",
          explanation: "Repository state requires human review before this can proceed automatically.",
          recommendedAction: "Review the repository status and insights, resolve the issues, then retry.",
        };
      case "BranchManagement":
        return {
          kind: "blocked",
          explanation:
            "A feature branch is required before implementing on this repository, but no automated capability exists yet to create one.",
          recommendedAction:
            'Create and switch to a feature branch manually (e.g. "git checkout -b <branch-name>"), then retry this request.',
        };
    }
  }

  private succeeded(result: ExecutionResult): boolean {
    return result.kind === "task" ? result.taskResult.success : result.workflowResult.status === "completed";
  }
}
