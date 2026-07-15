import type { IExecutionCoordinator } from "../src/coordination/interfaces";
import { ExecutionCoordinator } from "../src/coordination/ExecutionCoordinator";
import type { Capability, CapabilityProgram } from "../src/coordination/types";
import type { IControllerCore } from "../src/controller/interfaces";
import type { ExecutionRequest, ExecutionResult } from "../src/controller/types";
import type { IContextBuilder } from "../src/context/interfaces";
import type { ExecutionContext, ExecutionContextRequest } from "../src/context/types";
import type { IDecisionEngine } from "../src/decisions/interfaces";
import type { RepositoryInsightReport } from "../src/decisions/types";
import type { IRepositoryIntelligenceService } from "../src/intelligence/interfaces";
import type { RepositorySnapshot } from "../src/intelligence/types";
import type { Task } from "../src/planner/types";
import type { IPlanningEngine } from "../src/planning/interfaces";
import { PlanningEngine } from "../src/planning/PlanningEngine";
import type { DeliveryInput, ExecutionPlan } from "../src/planning/types";
import { ExecutionPipeline } from "../src/pipeline/ExecutionPipeline";
import type { PipelineResult } from "../src/pipeline/types";
import type { IClaudeSessionManager } from "../src/session/interfaces";
import type { ClaudeSessionDecision, ClaudeSessionInfo } from "../src/session/types";
import { StrategyEngine } from "../src/strategy/StrategyEngine";
import type { IExecutionStrategyEngine } from "../src/strategy/interfaces";
import type { StrategyRequest, TaskExecutionStrategy } from "../src/strategy/types";

function baseSnapshot(overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
  return {
    repository: { id: "alpha", name: "alpha", path: "/tmp/alpha", defaultBranch: "main", active: true },
    branch: { current: "main", default: "main", ahead: 0, behind: 0 },
    workingTree: { isClean: true, staged: [], unstaged: [], untracked: [] },
    recentCommits: [],
    pullRequests: { open: [], openCount: 0 },
    health: { isGitRepository: true, isClean: true, hasUnpushedCommits: false, isBehindRemote: false, hasOpenPullRequests: false, issues: [] },
    workflowReadiness: { canShip: true, requiresApprovalBeforePush: false, requiresApprovalBeforePullRequest: false, blockers: [] },
    generatedAt: new Date(),
    ...overrides,
  };
}

class FakeRepositoryIntelligence implements IRepositoryIntelligenceService {
  public callCount = 0;
  constructor(public snapshot: RepositorySnapshot) {}
  async getSnapshot(): Promise<RepositorySnapshot> {
    this.callCount += 1;
    return this.snapshot;
  }
}

class FakeControllerCore implements IControllerCore {
  public requests: ExecutionRequest[] = [];
  constructor(private readonly resultForCall: (request: ExecutionRequest, callIndex: number) => ExecutionResult) {}
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const result = this.resultForCall(request, this.requests.length);
    this.requests.push(request);
    return result;
  }
}

function taskResult(success: boolean, taskType: Task["type"] = "verify-git-status"): ExecutionResult {
  return {
    kind: "task",
    taskResult: { success, taskType, correlationId: "c1" },
    startedAt: new Date(),
    completedAt: new Date(),
    durationMs: 1,
  };
}

function workflowResult(status: "completed" | "failed"): ExecutionResult {
  return {
    kind: "workflow",
    workflowResult: { workflowId: "ship", correlationId: "c1", status, steps: [], startedAt: new Date(), completedAt: new Date(), durationMs: 1 },
    startedAt: new Date(),
    completedAt: new Date(),
    durationMs: 1,
  };
}

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

function full(result: PipelineResult): Extract<PipelineResult, { path: "full" }> {
  if (result.path !== "full") throw new Error(`expected path "full", got "${result.path}"`);
  return result;
}

function bypass(result: PipelineResult): Extract<PipelineResult, { path: "bypass" }> {
  if (result.path !== "bypass") throw new Error(`expected path "bypass", got "${result.path}"`);
  return result;
}

// --- Fakes for isolating ExecutionPipeline's own dispatch logic from the
// already-independently-verified StrategyEngine/PlanningEngine/ExecutionCoordinator ---

class FixedStrategyEngine implements IExecutionStrategyEngine {
  constructor(private readonly strategy: TaskExecutionStrategy) {}
  async recommend(_request: StrategyRequest): Promise<TaskExecutionStrategy> {
    return this.strategy;
  }
}

class FixedPlanningEngine implements IPlanningEngine {
  constructor(private readonly plan: ExecutionPlan) {}
  buildPlan(): ExecutionPlan {
    return this.plan;
  }
}

class FixedExecutionCoordinator implements IExecutionCoordinator {
  constructor(private readonly program: CapabilityProgram) {}
  buildProgram(): CapabilityProgram {
    return this.program;
  }
}

// Note: task is always a non-bypass type (implement-feature/analyze-repository/
// etc.) in these "full path" fixtures — create-commit/push-changes/create-pull-request
// would short-circuit to the real bypass path before ever reaching the Fixed fakes.
function fixedProgram(
  task: Task,
  steps: { capability: Capability; rationale?: string; deliveryInput?: DeliveryInput }[],
): CapabilityProgram {
  const plan: ExecutionPlan = {
    repositoryId: "alpha",
    task,
    strategy: {} as TaskExecutionStrategy,
    steps: [],
    generatedAt: new Date(),
  };
  return {
    repositoryId: "alpha",
    plan,
    steps: steps.map((s, i) => ({
      order: i + 1,
      goal: "VerifyRepositoryReadiness",
      capability: s.capability,
      rationale: s.rationale ?? "r",
      deliveryInput: s.deliveryInput,
    })),
    generatedAt: new Date(),
  };
}

async function main(): Promise<void> {
  // Scenario 1: single dispatchable capability -> executed, completed=true, PipelineContext fetched exactly once
  {
    const repositoryIntelligence = new FakeRepositoryIntelligence(baseSnapshot());
    const controllerCore = new FakeControllerCore(() => taskResult(true, "analyze-repository"));
    const task: Task = { type: "analyze-repository" };
    const program = fixedProgram(task, [{ capability: "VerifyRepository" }]);
    const pipeline = new ExecutionPipeline(
      repositoryIntelligence,
      new FixedStrategyEngine({} as TaskExecutionStrategy),
      new FixedPlanningEngine(program.plan),
      new FixedExecutionCoordinator(program),
      controllerCore,
    );
    const result = full(await pipeline.run({ kind: "task", task, repositoryId: "alpha" }));
    assert(result.completed === true, "single dispatchable capability -> completed");
    assert(result.stepOutcomes.length === 1 && result.stepOutcomes[0].status === "executed", "one executed outcome recorded");
    assert(repositoryIntelligence.callCount === 1, "getSnapshot() called exactly once for the whole run");
    assert(
      controllerCore.requests[0].kind === "task" && controllerCore.requests[0].task.type === "analyze-repository",
      "VerifyRepository dispatches the original task (analyze-repository), not a hardcoded verify-git-status — critical finding #2 fix",
    );
  }

  // Scenario 2: HumanReview capability -> structured "blocked" outcome (adjustment 3), nothing dispatched
  {
    const repositoryIntelligence = new FakeRepositoryIntelligence(baseSnapshot());
    const controllerCore = new FakeControllerCore(() => taskResult(true));
    const task: Task = { type: "explain-code", input: { target: "src/index.ts" } };
    const program = fixedProgram(task, [{ capability: "HumanReview" }]);
    const pipeline = new ExecutionPipeline(
      repositoryIntelligence,
      new FixedStrategyEngine({} as TaskExecutionStrategy),
      new FixedPlanningEngine(program.plan),
      new FixedExecutionCoordinator(program),
      controllerCore,
    );
    const result = full(await pipeline.run({ kind: "task", task, repositoryId: "alpha" }));
    assert(result.completed === false, "HumanReview -> not completed");
    const outcome = result.stepOutcomes[0];
    assert(outcome.status === "blocked", "HumanReview -> structured blocked outcome, not a generic skip");
    assert(
      outcome.status === "blocked" && outcome.explanation.length > 0 && outcome.recommendedAction.length > 0,
      "blocked outcome carries both an explanation and a recommendedAction",
    );
    assert(controllerCore.requests.length === 0, "HumanReview never reaches ControllerCore.execute()");
  }

  // Scenario 3: BranchManagement -> structured "blocked" outcome (adjustment 3), no legacy silent-continue fallback
  {
    const repositoryIntelligence = new FakeRepositoryIntelligence(baseSnapshot());
    const controllerCore = new FakeControllerCore(() => taskResult(true));
    const task: Task = { type: "implement-feature", input: { description: "x" } };
    const program = fixedProgram(task, [{ capability: "BranchManagement" }, { capability: "ContinueImplementation" }]);
    const pipeline = new ExecutionPipeline(
      repositoryIntelligence,
      new FixedStrategyEngine({} as TaskExecutionStrategy),
      new FixedPlanningEngine(program.plan),
      new FixedExecutionCoordinator(program),
      controllerCore,
    );
    const result = full(await pipeline.run({ kind: "task", task, repositoryId: "alpha" }));
    assert(result.stepOutcomes.length === 1, "BranchManagement blocked, ContinueImplementation never attempted");
    const outcome = result.stepOutcomes[0];
    assert(outcome.status === "blocked", "BranchManagement -> blocked, not silently skipped");
    assert(
      outcome.status === "blocked" && outcome.recommendedAction.toLowerCase().includes("branch"),
      "recommendedAction tells the user how to unblock it (create a branch manually)",
    );
    assert(controllerCore.requests.length === 0, "no ControllerCore calls made once blocked — implement-feature never silently ran on the default branch");
  }

  // Scenario 4: a failing step stops the pipeline before later steps run
  {
    const repositoryIntelligence = new FakeRepositoryIntelligence(baseSnapshot());
    const controllerCore = new FakeControllerCore((_req, callIndex) => taskResult(callIndex === 0 ? false : true));
    const task: Task = { type: "implement-feature", input: { description: "x" } };
    const program = fixedProgram(task, [{ capability: "VerifyRepository" }, { capability: "ContinueImplementation" }]);
    const pipeline = new ExecutionPipeline(
      repositoryIntelligence,
      new FixedStrategyEngine({} as TaskExecutionStrategy),
      new FixedPlanningEngine(program.plan),
      new FixedExecutionCoordinator(program),
      controllerCore,
    );
    const result = full(await pipeline.run({ kind: "task", task, repositoryId: "alpha" }));
    assert(result.completed === false, "a failed step -> pipeline not completed");
    assert(result.stepOutcomes.length === 1, "second step never dispatched after the first fails");
    assert(controllerCore.requests.length === 1, "only one ControllerCore.execute() call made");
  }

  // Scenario 5: IntegratedDelivery step carrying a deliveryInput already
  // captured by PlanningEngine -> ExecutionPipeline relays it verbatim.
  {
    const repositoryIntelligence = new FakeRepositoryIntelligence(baseSnapshot());
    const controllerCore = new FakeControllerCore(() => workflowResult("completed"));
    const task: Task = { type: "fix-bug", input: { description: "y" } };
    const deliveryInput: DeliveryInput = { message: "Add feature", body: "details", baseBranch: "main" };
    const program = fixedProgram(task, [{ capability: "IntegratedDelivery", deliveryInput }]);
    const pipeline = new ExecutionPipeline(
      repositoryIntelligence,
      new FixedStrategyEngine({} as TaskExecutionStrategy),
      new FixedPlanningEngine(program.plan),
      new FixedExecutionCoordinator(program),
      controllerCore,
    );
    const result = full(await pipeline.run({ kind: "task", task, repositoryId: "alpha" }));
    assert(result.completed === true, "IntegratedDelivery with a carried deliveryInput -> completed");
    const request = controllerCore.requests[0];
    assert(request.kind === "workflow" && request.workflowId === "ship", "IntegratedDelivery dispatches the ship workflow");
    assert(
      request.kind === "workflow" && request.input?.message === "Add feature" && request.input?.body === "details" && request.input?.baseBranch === "main",
      "deliveryInput relayed into the ship workflow's input unchanged",
    );
  }

  // Scenario 6: IntegratedDelivery step with no deliveryInput carried -> skipped (data gap, not blocked)
  {
    const repositoryIntelligence = new FakeRepositoryIntelligence(baseSnapshot());
    const controllerCore = new FakeControllerCore(() => workflowResult("completed"));
    const task: Task = { type: "fix-bug", input: { description: "y" } };
    const program = fixedProgram(task, [{ capability: "IntegratedDelivery" }]);
    const pipeline = new ExecutionPipeline(
      repositoryIntelligence,
      new FixedStrategyEngine({} as TaskExecutionStrategy),
      new FixedPlanningEngine(program.plan),
      new FixedExecutionCoordinator(program),
      controllerCore,
    );
    const result = full(await pipeline.run({ kind: "task", task, repositoryId: "alpha" }));
    assert(result.completed === false, "IntegratedDelivery with no carried deliveryInput -> not completed");
    assert(result.stepOutcomes[0].status === "skipped", "missing deliveryInput is a data gap ('skipped'), distinct from a structural gap ('blocked')");
    assert(controllerCore.requests.length === 0, "no ControllerCore call made");
  }

  // Scenario 7: correlation id supplied by the caller (Telegram) is preserved
  // through the full-stack path, never replaced by an internally-generated one.
  {
    const repositoryIntelligence = new FakeRepositoryIntelligence(baseSnapshot());
    const controllerCore = new FakeControllerCore(() => taskResult(true, "analyze-repository"));
    const task: Task = { type: "analyze-repository" };
    const program = fixedProgram(task, [{ capability: "VerifyRepository" }]);
    const pipeline = new ExecutionPipeline(
      repositoryIntelligence,
      new FixedStrategyEngine({} as TaskExecutionStrategy),
      new FixedPlanningEngine(program.plan),
      new FixedExecutionCoordinator(program),
      controllerCore,
    );
    await pipeline.run({ kind: "task", task, repositoryId: "alpha", correlationId: "telegram:12345:67" });
    assert(
      controllerCore.requests[0].correlationId === "telegram:12345:67",
      "caller-supplied correlationId (Telegram's chat/update-derived id) is preserved unchanged — critical finding #1 fix",
    );
  }

  // Scenario 8: no correlationId supplied -> pipeline generates one internally (non-Telegram callers)
  {
    const repositoryIntelligence = new FakeRepositoryIntelligence(baseSnapshot());
    const controllerCore = new FakeControllerCore(() => taskResult(true, "analyze-repository"));
    const task: Task = { type: "analyze-repository" };
    const program = fixedProgram(task, [{ capability: "VerifyRepository" }]);
    const pipeline = new ExecutionPipeline(
      repositoryIntelligence,
      new FixedStrategyEngine({} as TaskExecutionStrategy),
      new FixedPlanningEngine(program.plan),
      new FixedExecutionCoordinator(program),
      controllerCore,
    );
    await pipeline.run({ kind: "task", task, repositoryId: "alpha" });
    assert(
      typeof controllerCore.requests[0].correlationId === "string" && controllerCore.requests[0].correlationId!.length > 0,
      "no correlationId supplied -> pipeline generates one so the request is still traceable",
    );
  }

  // Scenario 9: bypass path — a "task" request for push-changes skips
  // Strategy/Planning/Coordination entirely but still routes through this
  // same ExecutionPipeline and still reaches ControllerCore only through it.
  {
    const repositoryIntelligence = new FakeRepositoryIntelligence(baseSnapshot());
    const controllerCore = new FakeControllerCore(() => taskResult(true, "push-changes"));
    let strategyCalled = false;
    let planningCalled = false;
    let coordinatorCalled = false;
    const strategyEngine: IExecutionStrategyEngine = { async recommend() { strategyCalled = true; return {} as TaskExecutionStrategy; } };
    const planningEngine: IPlanningEngine = { buildPlan() { planningCalled = true; return {} as ExecutionPlan; } };
    const executionCoordinator: IExecutionCoordinator = { buildProgram() { coordinatorCalled = true; return {} as CapabilityProgram; } };

    const pipeline = new ExecutionPipeline(repositoryIntelligence, strategyEngine, planningEngine, executionCoordinator, controllerCore);
    const task: Task = { type: "push-changes" };
    const result = bypass(await pipeline.run({ kind: "task", task, repositoryId: "alpha", correlationId: "telegram:1:1" }));

    assert(result.completed === true, "bypass path -> completed when ControllerCore succeeds");
    assert(!strategyCalled && !planningCalled && !coordinatorCalled, "bypass path never calls StrategyEngine/PlanningEngine/ExecutionCoordinator");
    assert(controllerCore.requests.length === 1 && controllerCore.requests[0].kind === "task" && controllerCore.requests[0].task.type === "push-changes", "bypass dispatches the original task directly to ControllerCore");
    assert(controllerCore.requests[0].correlationId === "telegram:1:1", "bypass path also preserves the caller-supplied correlationId");
  }

  // Scenario 10: create-commit and create-pull-request, submitted as literal
  // "task" requests (i.e. standalone "/commit" and "/create-pr"), also bypass.
  {
    const tasks: Task[] = [
      { type: "create-commit", input: { message: "wip" } },
      { type: "create-pull-request", input: { title: "t" } },
    ];
    for (const task of tasks) {
      const repositoryIntelligence = new FakeRepositoryIntelligence(baseSnapshot());
      const controllerCore = new FakeControllerCore(() => taskResult(true, task.type));
      const strategyEngine: IExecutionStrategyEngine = { async recommend() { throw new Error("must not be called for a bypass task"); } };
      const planningEngine: IPlanningEngine = { buildPlan() { throw new Error("must not be called for a bypass task"); } };
      const executionCoordinator: IExecutionCoordinator = { buildProgram() { throw new Error("must not be called for a bypass task"); } };
      const pipeline = new ExecutionPipeline(repositoryIntelligence, strategyEngine, planningEngine, executionCoordinator, controllerCore);
      const result = bypass(await pipeline.run({ kind: "task", task, repositoryId: "alpha" }));
      assert(result.completed === true, `standalone "${task.type}" bypasses the decision stack and dispatches directly`);
    }
  }

  // Scenario 11: "/ship" -> kind: "pipeline" -> ALWAYS full stack,
  // never bypass, even though the Task synthesized internally (create-commit)
  // is the same shape a bypass-eligible "task" request would carry. This is
  // exactly the collision the request-kind discriminant exists to resolve.
  {
    const repositoryIntelligence = new FakeRepositoryIntelligence(baseSnapshot());
    const controllerCore = new FakeControllerCore(() => workflowResult("completed"));
    let strategyCalled = false;
    const strategyEngine: IExecutionStrategyEngine = {
      async recommend(request) {
        strategyCalled = true;
        assert(request.task.type === "create-commit" && request.task.input.message === "Ship it", "pipeline request synthesizes a create-commit Task carrying the message");
        return { recommendedAction: "ShipChanges" } as TaskExecutionStrategy;
      },
    };
    const program = fixedProgram({ type: "create-commit", input: { message: "Ship it" } }, [
      { capability: "IntegratedDelivery", deliveryInput: { message: "Ship it" } },
    ]);
    const pipeline = new ExecutionPipeline(
      repositoryIntelligence,
      strategyEngine,
      new FixedPlanningEngine(program.plan),
      new FixedExecutionCoordinator(program),
      controllerCore,
    );
    const result = full(await pipeline.run({ kind: "pipeline", message: "Ship it", repositoryId: "alpha" }));
    assert(strategyCalled, "pipeline request reaches StrategyEngine — full stack, not bypass");
    assert(result.completed === true, "pipeline request completes via the ship workflow");
    assert(controllerCore.requests[0].kind === "workflow" && controllerCore.requests[0].workflowId === "ship", "pipeline request dispatches the ship workflow, exactly as a literal create-commit bypass request would not");
  }

  // Scenario 12: true end-to-end wiring with the real StrategyEngine, PlanningEngine, and ExecutionCoordinator
  {
    class FakeDecisionEngine implements IDecisionEngine {
      async analyze(snapshot: RepositorySnapshot): Promise<RepositoryInsightReport> {
        return { repositoryId: snapshot.repository.id, generatedAt: new Date(), insights: [], notificationWorthyInsights: [] };
      }
    }
    class FakeContextBuilder implements IContextBuilder {
      async build(request: ExecutionContextRequest): Promise<ExecutionContext> {
        return { repository: request.repository, recentHistory: [], relevantHistory: [], task: request.task, generatedAt: new Date(), warnings: [] };
      }
    }
    class FakeSessionManager implements IClaudeSessionManager {
      resolveSession(): ClaudeSessionDecision {
        throw new Error("not used");
      }
      resetSession(): void {}
      expireSession(): void {}
      getSessionStatus(): ClaudeSessionInfo | undefined {
        return undefined;
      }
    }

    const repositoryIntelligence = new FakeRepositoryIntelligence(baseSnapshot());
    const controllerCore = new FakeControllerCore(() => taskResult(true));
    const strategyEngine = new StrategyEngine(new FakeDecisionEngine(), new FakeContextBuilder(), new FakeSessionManager());
    const planningEngine = new PlanningEngine();
    const executionCoordinator = new ExecutionCoordinator();
    const pipeline = new ExecutionPipeline(repositoryIntelligence, strategyEngine, planningEngine, executionCoordinator, controllerCore);

    // implement-feature, no active session, on the default branch -> full
    // stack correctly recommends CreateFeatureBranch -> blocked, never bypassed.
    const implementTask: Task = { type: "implement-feature", input: { description: "add x" } };
    const implementResult = full(await pipeline.run({ kind: "task", task: implementTask, repositoryId: "alpha" }));
    assert(implementResult.strategy.recommendedAction === "CreateFeatureBranch", "end-to-end implement-feature, fresh session, default branch -> CreateFeatureBranch");
    assert(implementResult.stepOutcomes[0].status === "blocked", "end-to-end: correctly blocked rather than implementing on the default branch");
    assert(controllerCore.requests.length === 0, "end-to-end: no execution happened for the blocked implement-feature request");

    // analyze-repository -> full stack, AnalyzeFirst -> VerifyRepository -> dispatches the real analyze-repository task
    const analyzeTask: Task = { type: "analyze-repository" };
    const analyzeResult = full(await pipeline.run({ kind: "task", task: analyzeTask, repositoryId: "alpha" }));
    assert(analyzeResult.strategy.recommendedAction === "AnalyzeFirst", "end-to-end: analyze-repository -> AnalyzeFirst");
    assert(controllerCore.requests[0].kind === "task" && controllerCore.requests[0].task.type === "analyze-repository", "end-to-end: the real analyze-repository task is dispatched, not a substitute verify-git-status");

    // fix-bug, active session already established by a fake -> ContinueCurrentTask -> ContinueImplementation -> real fix-bug task dispatched
    const activeSessionManager = new (class implements IClaudeSessionManager {
      resolveSession(): ClaudeSessionDecision {
        throw new Error("not used");
      }
      resetSession(): void {}
      expireSession(): void {}
      getSessionStatus(): ClaudeSessionInfo | undefined {
        return { id: "s1", repositoryId: "alpha", status: "active", createdAt: new Date(), lastUsedAt: new Date() };
      }
    })();
    const sessionAwareStrategy = new StrategyEngine(new FakeDecisionEngine(), new FakeContextBuilder(), activeSessionManager);
    const sessionAwarePipeline = new ExecutionPipeline(repositoryIntelligence, sessionAwareStrategy, planningEngine, executionCoordinator, controllerCore);
    const fixTask: Task = { type: "fix-bug", input: { description: "null pointer" } };
    const fixResult = full(await sessionAwarePipeline.run({ kind: "task", task: fixTask, repositoryId: "alpha" }));
    assert(fixResult.strategy.recommendedAction === "ContinueCurrentTask", "end-to-end: fix-bug with an active session -> ContinueCurrentTask");
    const fixRequest = controllerCore.requests[controllerCore.requests.length - 1];
    assert(fixRequest.kind === "task" && fixRequest.task.type === "fix-bug", "end-to-end: the real fix-bug task is dispatched");

    // ship (kind: "pipeline") -> full stack -> ShipChanges -> DeliverIntegratedChange -> IntegratedDelivery -> ship workflow
    const shipResult = full(await pipeline.run({ kind: "pipeline", message: "Add dark mode", repositoryId: "alpha" }));
    assert(shipResult.strategy.recommendedAction === "ShipChanges", "end-to-end: /ship -> ShipChanges");
    const shipRequest = controllerCore.requests[controllerCore.requests.length - 1];
    assert(shipRequest.kind === "workflow" && shipRequest.workflowId === "ship" && shipRequest.input?.message === "Add dark mode", "end-to-end: ship workflow dispatched with the message");

    // standalone push-changes ("/push") -> bypass, never reinterpreted as ShipChanges
    const pushResult = bypass(await pipeline.run({ kind: "task", task: { type: "push-changes" }, repositoryId: "alpha" }));
    assert(pushResult.request.kind === "task" && pushResult.request.task.type === "push-changes", "end-to-end: standalone /push dispatches only push-changes, never the full ship workflow");
  }
}

main();
