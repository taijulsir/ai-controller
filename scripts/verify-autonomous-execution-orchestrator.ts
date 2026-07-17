import { AutonomousExecutionOrchestrator } from "../src/autonomousexecution/AutonomousExecutionOrchestrator";
import type { IAutonomousPlanScheduleProvider } from "../src/application/interfaces";
import type { AutonomousPlanSchedulingEntry, AutonomousPlanSchedulingReport } from "../src/scheduling/types";
import type { RecommendationKind } from "../src/recommendations/types";
import type { IExecutionPipeline } from "../src/pipeline/interfaces";
import type { PipelineRequest, PipelineResult } from "../src/pipeline/types";
import { ExecutionPipeline } from "../src/pipeline/ExecutionPipeline";
import { ApprovalEngine } from "../src/approval/ApprovalEngine";
import type { IApprovalProvider } from "../src/approval/interfaces";
import type { ApprovalDecision, ApprovalRequest } from "../src/approval/types";
import { ControllerCore } from "../src/controller/ControllerCore";
import { DeferredControllerCore } from "../src/controller/DeferredControllerCore";
import type { ExecutionRequest, ExecutionResult } from "../src/controller/types";
import { isTaskExecutionResult } from "../src/controller/types";
import { WorkflowOrchestrator } from "../src/orchestration/WorkflowOrchestrator";
import { WorkflowRegistry } from "../src/orchestration/WorkflowRegistry";
import type { ITaskPlanner } from "../src/planner/interfaces";
import type { Task, TaskExecutionContext, TaskResult } from "../src/planner/types";
import { PlanningEngine } from "../src/planning/PlanningEngine";
import { ExecutionCoordinator } from "../src/coordination/ExecutionCoordinator";
import { StrategyEngine } from "../src/strategy/StrategyEngine";
import type { IDecisionEngine } from "../src/decisions/interfaces";
import type { RepositoryInsightReport } from "../src/decisions/types";
import type { IContextBuilder } from "../src/context/interfaces";
import type { ExecutionContext, ExecutionContextRequest } from "../src/context/types";
import type { IClaudeSessionManager } from "../src/session/interfaces";
import type { ClaudeSessionDecision, ClaudeSessionInfo } from "../src/session/types";
import type { IRepositoryIntelligenceService } from "../src/intelligence/interfaces";
import type { RepositorySnapshot } from "../src/intelligence/types";
import type { IRepositoryRegistry } from "../src/repositories/interfaces";
import type { Repository } from "../src/domain/repository/Repository";
import type { IConfigService } from "../src/config/interfaces";
import type { ClaudeConfig, ControllerConfig, GithubConfig, TelegramConfig } from "../src/config/types";

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

function schedulingEntry(overrides: Partial<AutonomousPlanSchedulingEntry> & Pick<AutonomousPlanSchedulingEntry, "repositoryId" | "sourceRecommendationKind">): AutonomousPlanSchedulingEntry {
  return { level: "high", cycleCount: 1, cadence: "frequent", ...overrides };
}

function schedulingReport(entries: AutonomousPlanSchedulingEntry[]): AutonomousPlanSchedulingReport {
  return {
    generatedAt: new Date(),
    summary: { entriesScheduled: entries.length, currentness: "current", cadenceBreakdown: { frequent: entries.length, periodic: 0, infrequent: 0 } },
    entries,
  };
}

// ---- Part 1: the orchestrator's own translation logic, in isolation ----

class FakeScheduleProvider implements IAutonomousPlanScheduleProvider {
  public limitsRequested: (number | undefined)[] = [];
  constructor(private readonly report: AutonomousPlanSchedulingReport) {}
  async getAutonomousPlanSchedule(limit?: number): Promise<AutonomousPlanSchedulingReport> {
    this.limitsRequested.push(limit);
    return this.report;
  }
}

class RecordingExecutionPipeline implements IExecutionPipeline {
  public requests: PipelineRequest[] = [];
  constructor(private readonly result: PipelineResult) {}
  async run(request: PipelineRequest): Promise<PipelineResult> {
    this.requests.push(request);
    return this.result;
  }
}

function canned(): PipelineResult {
  const context = { task: { type: "create-commit" as const, input: { message: "x" } }, repositoryId: "alpha", repository: {} as RepositorySnapshot, generatedAt: new Date() };
  return { path: "bypass", context, request: { kind: "task", task: { type: "verify-git-status" } }, result: { kind: "task", taskResult: { success: true, taskType: "verify-git-status", correlationId: "c" }, startedAt: new Date(), completedAt: new Date(), durationMs: 1 }, completed: true };
}

const ALL_RECOMMENDATION_KINDS: RecommendationKind[] = ["RepositoryReadyToShip", "ContinueSession", "ReviewPullRequest", "PullRequired", "RepeatedFailures", "ReviewChanges"];

async function verifyTranslationInIsolation(): Promise<void> {
  // Empty schedule -> no attempt, ever.
  {
    const scheduleProvider = new FakeScheduleProvider(schedulingReport([]));
    const pipeline = new RecordingExecutionPipeline(canned());
    const orchestrator = new AutonomousExecutionOrchestrator(scheduleProvider, pipeline);

    const result = await orchestrator.attemptExecution();
    assert(result === undefined, "an empty schedule -> attemptExecution() returns undefined");
    assert(pipeline.requests.length === 0, "an empty schedule -> IExecutionPipeline.run() is never called");
    assert(scheduleProvider.limitsRequested[0] === 1, "the orchestrator requests only the single highest-priority entry (limit: 1)");
  }

  // RepositoryReadyToShip -> translates and submits correctly.
  {
    const entry = schedulingEntry({ repositoryId: "alpha", sourceRecommendationKind: "RepositoryReadyToShip", level: "high" });
    const scheduleProvider = new FakeScheduleProvider(schedulingReport([entry]));
    const cannedResult = canned();
    const pipeline = new RecordingExecutionPipeline(cannedResult);
    const orchestrator = new AutonomousExecutionOrchestrator(scheduleProvider, pipeline);

    const result = await orchestrator.attemptExecution();
    assert(pipeline.requests.length === 1, "RepositoryReadyToShip -> IExecutionPipeline.run() is called exactly once");
    const request = pipeline.requests[0];
    assert(request.kind === "pipeline", "the translated request is the 'pipeline' kind -- the exact shape TelegramAdapter already builds for /ship");
    assert(request.kind === "pipeline" && request.repositoryId === "alpha", "the translated request carries the exact repositoryId from the scheduled entry");
    assert(request.kind === "pipeline" && request.message.includes("alpha") && request.message.includes("high"), "the translated request's message is derived from the entry's own repositoryId/level, not fabricated from nothing");
    assert(request.kind === "pipeline" && request.correlationId === undefined, "no correlationId is invented -- ExecutionPipeline generates one internally, exactly as its own doc comment anticipates for a non-Telegram trigger");
    assert(result === cannedResult, "attemptExecution() returns exactly what IExecutionPipeline.run() produced, never a wrapped or reinterpreted result");
  }

  // Every RecommendationKind other than RepositoryReadyToShip -> no attempt.
  for (const kind of ALL_RECOMMENDATION_KINDS.filter((k) => k !== "RepositoryReadyToShip")) {
    const entry = schedulingEntry({ repositoryId: "alpha", sourceRecommendationKind: kind });
    const scheduleProvider = new FakeScheduleProvider(schedulingReport([entry]));
    const pipeline = new RecordingExecutionPipeline(canned());
    const orchestrator = new AutonomousExecutionOrchestrator(scheduleProvider, pipeline);

    const result = await orchestrator.attemptExecution();
    assert(result === undefined, `RecommendationKind "${kind}" as the top entry -> attemptExecution() returns undefined`);
    assert(pipeline.requests.length === 0, `RecommendationKind "${kind}" as the top entry -> IExecutionPipeline.run() is never called`);
  }

  // Only the highest-priority (first) entry is ever consulted -- a
  // translatable entry buried behind an untranslatable top entry is never
  // reached, exactly as "select the highest-priority scheduled item" (not
  // "the first translatable one") requires.
  {
    const entries = [
      schedulingEntry({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" }),
      schedulingEntry({ repositoryId: "beta", sourceRecommendationKind: "RepositoryReadyToShip" }),
    ];
    const scheduleProvider = new FakeScheduleProvider(schedulingReport(entries));
    const pipeline = new RecordingExecutionPipeline(canned());
    const orchestrator = new AutonomousExecutionOrchestrator(scheduleProvider, pipeline);

    const result = await orchestrator.attemptExecution();
    assert(result === undefined, "a translatable entry behind a non-translatable top entry is never reached");
    assert(pipeline.requests.length === 0, "the orchestrator never looks past the top entry, even when a later one would translate");
  }
}

// ---- Part 2: real end-to-end integration -- proving ApprovalEngine is
// still reached through the existing, unmodified execution path ----

function baseSnapshot(): RepositorySnapshot {
  return {
    repository: { id: "alpha", name: "alpha", path: "/tmp/alpha", defaultBranch: "main", active: true },
    branch: { current: "main", default: "main", ahead: 0, behind: 0 },
    workingTree: { isClean: true, staged: [], unstaged: [], untracked: [] },
    recentCommits: [],
    pullRequests: { open: [], openCount: 0 },
    health: { isGitRepository: true, isClean: true, hasUnpushedCommits: false, isBehindRemote: false, hasOpenPullRequests: false, issues: [] },
    workflowReadiness: { canShip: true, requiresApprovalBeforePush: false, requiresApprovalBeforePullRequest: false, blockers: [] },
    generatedAt: new Date(),
  };
}

class FakeRepositoryIntelligence implements IRepositoryIntelligenceService {
  async getSnapshot(): Promise<RepositorySnapshot> {
    return baseSnapshot();
  }
}
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
class FakeRepositoryRegistry implements IRepositoryRegistry {
  constructor(private readonly repositories: Repository[]) {}
  getAllRepositories(): Repository[] {
    return this.repositories;
  }
  getRepository(id: string): Repository {
    const found = this.repositories.find((r) => r.id === id);
    if (!found) throw new Error(`not found: ${id}`);
    return found;
  }
  getActiveRepository(): Repository | undefined {
    return this.repositories[0];
  }
  setActiveRepository(): void {
    throw new Error("not used");
  }
  repositoryExists(): boolean {
    throw new Error("not used");
  }
  refresh(): void {
    throw new Error("not used");
  }
}
class FakeConfigService implements IConfigService {
  constructor(private readonly approval: ControllerConfig["approval"]) {}
  getControllerConfig(): ControllerConfig {
    return {
      controller: { name: "test", version: "0.0.0", environment: "test" },
      workspace: { root: "/tmp" },
      task: { max_concurrent_jobs: 1, timeout_minutes: 1 },
      approval: this.approval,
      logging: { enabled: false, level: "info", directory: "/tmp" },
      memory: { enabled: true, directory: "/tmp" },
    };
  }
  getClaudeConfig(): ClaudeConfig {
    throw new Error("not used");
  }
  getGithubConfig(): GithubConfig {
    throw new Error("not used");
  }
  getTelegramConfig(): TelegramConfig {
    throw new Error("not used");
  }
  getRepositories(): Repository[] {
    throw new Error("not used");
  }
  reload(): void {
    throw new Error("not used");
  }
}
class RecordingApprovalProvider implements IApprovalProvider {
  public requests: ApprovalRequest[] = [];
  constructor(private readonly decisionFor: (request: ApprovalRequest) => ApprovalDecision) {}
  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return this.decisionFor(request);
  }
}
class RecordingTaskPlanner implements ITaskPlanner {
  public calls: Task[] = [];
  constructor(private readonly resultFor: (task: Task) => Pick<TaskResult, "success" | "output">) {}
  async run(task: Task, context?: TaskExecutionContext): Promise<TaskResult> {
    this.calls.push(task);
    const outcome = this.resultFor(task);
    return { taskType: task.type, correlationId: context?.correlationId ?? "unused", ...outcome };
  }
}

// Assembles the real chain exactly as src/index.ts wires it: DeferredControllerCore
// -> WorkflowOrchestrator(real WorkflowRegistry, real shipWorkflow) -> ControllerCore
// -> ApprovalEngine(real ApprovalPolicy) -> bound back into the deferred entry
// point, which is what both ExecutionPipeline and WorkflowOrchestrator hold.
// Only ITaskPlanner is faked (no real git/GitHub/Claude calls), and
// IRepositoryIntelligenceService/IDecisionEngine/IContextBuilder/
// IClaudeSessionManager are faked exactly as verify-execution-pipeline.ts's
// own "true end-to-end" scenario already does.
function buildRealChain(approvalConfig: ControllerConfig["approval"], approvalDecision: (request: ApprovalRequest) => ApprovalDecision, taskOutcome: (task: Task) => Pick<TaskResult, "success" | "output">) {
  const deferredEntryPoint = new DeferredControllerCore();
  const workflowRegistry = new WorkflowRegistry();
  const workflowOrchestrator = new WorkflowOrchestrator(deferredEntryPoint, workflowRegistry);
  const taskPlanner = new RecordingTaskPlanner(taskOutcome);
  const repositoryRegistry = new FakeRepositoryRegistry([{ id: "alpha", name: "alpha", path: "/tmp/alpha", defaultBranch: "main", active: true }]);
  const plainControllerCore = new ControllerCore(repositoryRegistry, taskPlanner, workflowOrchestrator);
  const approvalProvider = new RecordingApprovalProvider(approvalDecision);
  const configService = new FakeConfigService(approvalConfig);
  const approvalEngine = new ApprovalEngine(plainControllerCore, configService, approvalProvider);
  deferredEntryPoint.bind(approvalEngine);

  const strategyEngine = new StrategyEngine(new FakeDecisionEngine(), new FakeContextBuilder(), new FakeSessionManager());
  const planningEngine = new PlanningEngine();
  const executionCoordinator = new ExecutionCoordinator();
  const executionPipeline = new ExecutionPipeline(new FakeRepositoryIntelligence(), strategyEngine, planningEngine, executionCoordinator, deferredEntryPoint);

  return { executionPipeline, taskPlanner, approvalProvider };
}

function stepFor(result: PipelineResult, taskType: Task["type"]): ExecutionResult | undefined {
  if (result.path !== "full") return undefined;
  const shipOutcome = result.stepOutcomes.find((o) => o.status === "executed" && o.capability === "IntegratedDelivery");
  if (!shipOutcome || shipOutcome.status !== "executed" || shipOutcome.result.kind !== "workflow") return undefined;
  return shipOutcome.result.workflowResult.steps.find((s) => s.taskType === taskType)?.executionResult;
}

async function verifyApprovalEngineIsReached(): Promise<void> {
  // Scenario A: both gates configured on, both approved -- every gated step
  // reaches the real ApprovalProvider, every ungated step never does, and
  // the whole ship workflow completes.
  {
    const { executionPipeline, taskPlanner, approvalProvider } = buildRealChain(
      { mode: "manual", require_before_git_push: true, require_before_pull_request: true },
      () => ({ approved: true }),
      () => ({ success: true }),
    );
    const scheduleProvider = new FakeScheduleProvider(schedulingReport([schedulingEntry({ repositoryId: "alpha", sourceRecommendationKind: "RepositoryReadyToShip", level: "high" })]));
    const orchestrator = new AutonomousExecutionOrchestrator(scheduleProvider, executionPipeline);

    const result = await orchestrator.attemptExecution();
    assert(result !== undefined, "RepositoryReadyToShip -> attemptExecution() actually submits and returns a real PipelineResult");
    assert(result?.path === "full", "the request runs through the full Strategy/Planning/Coordination stack, exactly as /ship already does");
    assert(taskPlanner.calls.map((t) => t.type).join(",") === "verify-git-status,create-commit,push-changes,create-pull-request", `the real shipWorkflow's four steps run, in order, unmodified (saw: ${taskPlanner.calls.map((t) => t.type).join(",")})`);
    assert(approvalProvider.requests.length === 2, `ApprovalEngine requests approval exactly twice -- once for push-changes, once for create-pull-request (saw ${approvalProvider.requests.length})`);
    assert(approvalProvider.requests.every((r) => r.task.type === "push-changes" || r.task.type === "create-pull-request"), "only push-changes and create-pull-request ever reach the approval provider -- verify-git-status and create-commit never do, exactly as the real, unmodified ApprovalPolicy dictates");
    const pushOutcome = result && stepFor(result, "push-changes");
    assert(pushOutcome !== undefined && isTaskExecutionResult(pushOutcome) && pushOutcome.approval?.required === true, "push-changes' own ExecutionResult carries approval.required: true -- a fingerprint only ApprovalEngine itself attaches, proving it was actually reached, not merely present in the dependency graph");
    const prOutcome = result && stepFor(result, "create-pull-request");
    assert(prOutcome !== undefined && isTaskExecutionResult(prOutcome) && prOutcome.approval?.required === true, "create-pull-request's own ExecutionResult likewise carries approval.required: true");
  }

  // Scenario B: push is denied -- the ship workflow must stop there, and
  // create-pull-request must never be attempted or even requested.
  {
    const { executionPipeline, taskPlanner, approvalProvider } = buildRealChain(
      { mode: "manual", require_before_git_push: true, require_before_pull_request: true },
      (request) => (request.task.type === "push-changes" ? { approved: false, reason: "denied in test" } : { approved: true }),
      () => ({ success: true }),
    );
    const scheduleProvider = new FakeScheduleProvider(schedulingReport([schedulingEntry({ repositoryId: "alpha", sourceRecommendationKind: "RepositoryReadyToShip", level: "high" })]));
    const orchestrator = new AutonomousExecutionOrchestrator(scheduleProvider, executionPipeline);

    const result = await orchestrator.attemptExecution();
    // Note: PipelineResult.completed reflects whether the one outer
    // IntegratedDelivery step "executed" (it did -- ControllerCore was
    // reached and returned a workflow-kind result) -- the *nested*
    // shipWorkflow's own failure lives inside that step's own
    // workflowResult.status, asserted directly below via stepFor().
    const shipStep = result?.path === "full" ? result.stepOutcomes.find((o) => o.status === "executed" && o.capability === "IntegratedDelivery") : undefined;
    const shipWorkflowResult = shipStep && shipStep.status === "executed" && shipStep.result.kind === "workflow" ? shipStep.result.workflowResult : undefined;
    assert(shipWorkflowResult?.status === "failed", "a denied push-changes approval -> the ship workflow's own nested status is 'failed', not silently reported as success");
    assert(taskPlanner.calls.map((t) => t.type).join(",") === "verify-git-status,create-commit", `execution stops immediately after the denied step -- push-changes' own inner ControllerCore is never reached, and create-pull-request is never attempted (saw: ${taskPlanner.calls.map((t) => t.type).join(",")})`);
    assert(approvalProvider.requests.length === 1 && approvalProvider.requests[0].task.type === "push-changes", "create-pull-request is never even requested for approval once push-changes was denied");
    const pushOutcome = result && stepFor(result, "push-changes");
    assert(pushOutcome !== undefined && isTaskExecutionResult(pushOutcome) && pushOutcome.taskResult.success === false && pushOutcome.taskResult.error === "denied in test", "the denied step's own ExecutionResult carries ApprovalEngine's own rejection reason verbatim");
  }

  // Scenario C: approval not required by policy (both flags off) -- every
  // step still runs, but the approval provider is never invoked at all,
  // proving ApprovalEngine's policy check itself (not just its presence)
  // runs for a request this orchestrator submits.
  {
    const { executionPipeline, taskPlanner, approvalProvider } = buildRealChain(
      { mode: "manual", require_before_git_push: false, require_before_pull_request: false },
      () => ({ approved: true }),
      () => ({ success: true }),
    );
    const scheduleProvider = new FakeScheduleProvider(schedulingReport([schedulingEntry({ repositoryId: "alpha", sourceRecommendationKind: "RepositoryReadyToShip", level: "high" })]));
    const orchestrator = new AutonomousExecutionOrchestrator(scheduleProvider, executionPipeline);

    const result = await orchestrator.attemptExecution();
    assert(result?.completed === true, "with approval not required by policy, the ship workflow still completes end to end");
    assert(taskPlanner.calls.length === 4, "all four shipWorkflow steps still run when approval is not required");
    assert(approvalProvider.requests.length === 0, "the approval provider is never invoked when ApprovalPolicy.requiresApproval() returns false -- ApprovalEngine's real policy evaluation ran and correctly decided not to gate, it did not simply get bypassed");
    const pushOutcome = result && stepFor(result, "push-changes");
    assert(pushOutcome !== undefined && isTaskExecutionResult(pushOutcome) && pushOutcome.approval?.required === false, "push-changes' own ExecutionResult carries approval.required: false -- ApprovalEngine's attachApproval() ran and recorded its own real decision, it did not skip the step entirely");
  }
}

async function main(): Promise<void> {
  await verifyTranslationInIsolation();
  await verifyApprovalEngineIsReached();
}

main();
