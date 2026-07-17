import { AutonomousExecutionWorker } from "../src/runtime/AutonomousExecutionWorker";
import { BackgroundRuntime } from "../src/runtime/BackgroundRuntime";
import { AutonomousExecutionOrchestrator } from "../src/autonomousexecution/AutonomousExecutionOrchestrator";
import type { IAutonomousExecutionOrchestrator } from "../src/autonomousexecution/interfaces";
import type { IAutonomousPlanScheduleProvider } from "../src/application/interfaces";
import type { IRecentExecutionHistoryProvider } from "../src/memory/interfaces";
import type { ProjectMemoryEvent } from "../src/memory/types";
import type { AutonomousPlanSchedulingEntry, AutonomousPlanSchedulingReport } from "../src/scheduling/types";
import type { PipelineResult } from "../src/pipeline/types";
import { ExecutionPipeline } from "../src/pipeline/ExecutionPipeline";
import { ApprovalEngine } from "../src/approval/ApprovalEngine";
import { TelegramApprovalProvider } from "../src/telegram/TelegramApprovalProvider";
import type { ITelegramClient, ITelegramSecurity } from "../src/telegram/interfaces";
import type { OutgoingMessage, TelegramUpdate } from "../src/telegram/types";
import { ControllerCore } from "../src/controller/ControllerCore";
import { DeferredControllerCore } from "../src/controller/DeferredControllerCore";
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function schedulingEntry(overrides: Partial<AutonomousPlanSchedulingEntry> & Pick<AutonomousPlanSchedulingEntry, "repositoryId" | "sourceRecommendationKind">): AutonomousPlanSchedulingEntry {
  return { level: "high", cycleCount: 1, cadence: "frequent", ...overrides };
}
function schedulingReport(entries: AutonomousPlanSchedulingEntry[]): AutonomousPlanSchedulingReport {
  return { generatedAt: new Date(), summary: { entriesScheduled: entries.length, currentness: "current", cadenceBreakdown: { frequent: entries.length, periodic: 0, infrequent: 0 } }, entries };
}

class FakeScheduleProvider implements IAutonomousPlanScheduleProvider {
  public calls: (number | undefined)[] = [];
  constructor(private readonly report: AutonomousPlanSchedulingReport) {}
  async getAutonomousPlanSchedule(limit?: number): Promise<AutonomousPlanSchedulingReport> {
    this.calls.push(limit);
    return this.report;
  }
}

class FakeHistoryProvider implements IRecentExecutionHistoryProvider {
  public calls: { repositoryId?: string; limit?: number }[] = [];
  constructor(private readonly events: ProjectMemoryEvent[]) {}
  async getRecentEvents(options: { repositoryId?: string; limit?: number } = {}): Promise<ProjectMemoryEvent[]> {
    this.calls.push(options);
    return this.events;
  }
}

class RecordingOrchestrator implements IAutonomousExecutionOrchestrator {
  public calls: (string | undefined)[] = [];
  private inFlight = 0;
  maxConcurrentObserved = 0;
  constructor(
    private readonly result: PipelineResult | undefined = undefined,
    private readonly delayMs = 0,
    private readonly shouldThrow = false,
  ) {}
  async attemptExecution(correlationId?: string): Promise<PipelineResult | undefined> {
    this.calls.push(correlationId);
    this.inFlight += 1;
    this.maxConcurrentObserved = Math.max(this.maxConcurrentObserved, this.inFlight);
    if (this.delayMs > 0) {
      await delay(this.delayMs);
    }
    this.inFlight -= 1;
    if (this.shouldThrow) {
      throw new Error("orchestrator refuses to execute");
    }
    return this.result;
  }
}

function cannedResult(): PipelineResult {
  return {
    path: "bypass",
    context: { task: { type: "verify-git-status" }, repositoryId: "alpha", repository: {} as RepositorySnapshot, generatedAt: new Date() },
    request: { kind: "task", task: { type: "verify-git-status" } },
    result: { kind: "task", taskResult: { success: true, taskType: "verify-git-status", correlationId: "c" }, startedAt: new Date(), completedAt: new Date(), durationMs: 1 },
    completed: true,
  };
}

function memoryEvent(repositoryId: string, recordedAt: Date): ProjectMemoryEvent {
  return {
    id: "e1",
    recordedAt,
    repositoryId,
    outcome: { kind: "result", result: { kind: "task", taskResult: { success: true, taskType: "push-changes", correlationId: "c" }, startedAt: new Date(), completedAt: new Date(), durationMs: 1 } },
  };
}

// ---- Part 1: lifecycle, periodic ticking, history-based suppression, isolation -- all against fakes ----

async function verifyWorkerBehaviorInIsolation(): Promise<void> {
  // Empty schedule -> the worker still ticks (reads the schedule every
  // interval) but never even checks history, and never attempts.
  {
    const scheduleProvider = new FakeScheduleProvider(schedulingReport([]));
    const historyProvider = new FakeHistoryProvider([]);
    const orchestrator = new RecordingOrchestrator();
    const worker = new AutonomousExecutionWorker(scheduleProvider, historyProvider, orchestrator, 20);

    worker.start();
    await delay(50);
    worker.stop();

    assert(scheduleProvider.calls.length >= 2, `the worker ticks its own interval and reads the schedule each time (saw ${scheduleProvider.calls.length} reads)`);
    assert(scheduleProvider.calls.every((limit) => limit === 1), "the worker always requests only the single highest-priority entry (limit: 1)");
    assert(historyProvider.calls.length === 0, "an empty schedule never even reaches the history check");
    assert(orchestrator.calls.length === 0, "an empty schedule never attempts execution");
  }

  // A translatable top entry, no recent history at all -> repeated,
  // periodic attempts, each with no correlationId.
  {
    const entry = schedulingEntry({ repositoryId: "alpha", sourceRecommendationKind: "RepositoryReadyToShip" });
    const scheduleProvider = new FakeScheduleProvider(schedulingReport([entry]));
    const historyProvider = new FakeHistoryProvider([]);
    const orchestrator = new RecordingOrchestrator(cannedResult());
    const worker = new AutonomousExecutionWorker(scheduleProvider, historyProvider, orchestrator, 20);

    worker.start();
    await delay(55); // ~2 ticks at 20ms
    worker.stop();

    assert(orchestrator.calls.length >= 2, `repeated ticks each independently attempt execution (saw ${orchestrator.calls.length} attempts)`);
    assert(orchestrator.calls.every((correlationId) => correlationId === undefined), "attemptExecution() is never supplied a correlationId -- there is no chat this worker's own trigger could correlate back to");
    assert(historyProvider.calls[0]?.repositoryId === "alpha" && historyProvider.calls[0]?.limit === 1, "the history check is scoped to the exact repository the schedule surfaced, requesting only the single most recent event");
  }

  // A recent execution event for the scheduled repository -> every tick is
  // suppressed, even though a translatable entry exists.
  {
    const entry = schedulingEntry({ repositoryId: "alpha", sourceRecommendationKind: "RepositoryReadyToShip" });
    const scheduleProvider = new FakeScheduleProvider(schedulingReport([entry]));
    const historyProvider = new FakeHistoryProvider([memoryEvent("alpha", new Date())]); // just recorded
    const orchestrator = new RecordingOrchestrator(cannedResult());
    const worker = new AutonomousExecutionWorker(scheduleProvider, historyProvider, orchestrator, 20);

    worker.start();
    await delay(55);
    worker.stop();

    assert(scheduleProvider.calls.length >= 2, "the worker still ticks and reads the schedule even while suppressed");
    assert(orchestrator.calls.length === 0, "a recent execution event suppresses every attempt, on every tick");
  }

  // A stale execution event (well outside the recency window) -> does not
  // suppress -- only genuinely recent activity counts.
  {
    const entry = schedulingEntry({ repositoryId: "alpha", sourceRecommendationKind: "RepositoryReadyToShip" });
    const scheduleProvider = new FakeScheduleProvider(schedulingReport([entry]));
    const staleEvent = memoryEvent("alpha", new Date(Date.now() - 2 * 60 * 60 * 1000)); // 2 hours ago
    const historyProvider = new FakeHistoryProvider([staleEvent]);
    const orchestrator = new RecordingOrchestrator(cannedResult());
    const worker = new AutonomousExecutionWorker(scheduleProvider, historyProvider, orchestrator, 20);

    worker.start();
    await delay(30);
    worker.stop();

    assert(orchestrator.calls.length >= 1, "an execution event outside the recency window does not suppress an attempt");
  }

  // Re-entrancy guard: a slow orchestrator must not let two attempts run
  // concurrently.
  {
    const entry = schedulingEntry({ repositoryId: "alpha", sourceRecommendationKind: "RepositoryReadyToShip" });
    const scheduleProvider = new FakeScheduleProvider(schedulingReport([entry]));
    const historyProvider = new FakeHistoryProvider([]);
    const orchestrator = new RecordingOrchestrator(cannedResult(), 40);
    const worker = new AutonomousExecutionWorker(scheduleProvider, historyProvider, orchestrator, 10);

    worker.start();
    await delay(90);
    worker.stop();

    assert(orchestrator.maxConcurrentObserved === 1, "overlapping ticks are skipped -- attemptExecution() is never called concurrently with itself");
  }

  // A throwing orchestrator is caught and logged, never crashes the worker
  // or stops future ticks.
  {
    const entry = schedulingEntry({ repositoryId: "alpha", sourceRecommendationKind: "RepositoryReadyToShip" });
    const scheduleProvider = new FakeScheduleProvider(schedulingReport([entry]));
    const historyProvider = new FakeHistoryProvider([]);
    const orchestrator = new RecordingOrchestrator(undefined, 0, true);
    const worker = new AutonomousExecutionWorker(scheduleProvider, historyProvider, orchestrator, 20);

    worker.start();
    await delay(55);
    worker.stop();

    assert(orchestrator.calls.length >= 2, `a throwing orchestrator does not stop future ticks from occurring (saw ${orchestrator.calls.length} attempts)`);
  }

  // start()/stop() lifecycle: idempotent, safe before start(), halts ticking deterministically.
  {
    const scheduleProvider = new FakeScheduleProvider(schedulingReport([]));
    const historyProvider = new FakeHistoryProvider([]);
    const orchestrator = new RecordingOrchestrator();
    const worker = new AutonomousExecutionWorker(scheduleProvider, historyProvider, orchestrator, 15);

    let threw = false;
    try {
      worker.stop();
    } catch {
      threw = true;
    }
    assert(!threw, "stop() before start() does not throw");

    worker.start();
    worker.start(); // idempotent, not a second interval
    await delay(50);
    worker.stop();
    const readsAtStop = scheduleProvider.calls.length;
    worker.stop(); // idempotent, not an error
    await delay(40);
    assert(scheduleProvider.calls.length === readsAtStop, "calling start() or stop() twice does not leak a second interval, and stop() halts ticking deterministically");
  }
}

// ---- Part 2: real BackgroundRuntime hosting ----

async function verifyBackgroundRuntimeIntegration(): Promise<void> {
  const entry = schedulingEntry({ repositoryId: "alpha", sourceRecommendationKind: "RepositoryReadyToShip" });
  const scheduleProvider = new FakeScheduleProvider(schedulingReport([entry]));
  const historyProvider = new FakeHistoryProvider([]);
  const orchestrator = new RecordingOrchestrator(cannedResult());
  const worker = new AutonomousExecutionWorker(scheduleProvider, historyProvider, orchestrator, 20);
  const runtime = new BackgroundRuntime([worker]);

  runtime.start();
  await delay(25);
  assert(runtime.getStatus().workers.find((w) => w.id === "autonomous-execution-worker")?.running === true, "BackgroundRuntime reports the worker as running once started");
  runtime.stop();
  const callsAtStop = orchestrator.calls.length;
  assert(callsAtStop >= 1, "BackgroundRuntime successfully hosts a real AutonomousExecutionWorker end-to-end");
  assert(runtime.getStatus().workers.find((w) => w.id === "autonomous-execution-worker")?.running === false, "BackgroundRuntime reports the worker as not running once stopped");

  await delay(40);
  assert(orchestrator.calls.length === callsAtStop, "BackgroundRuntime.stop() gracefully halts this worker's ticking, same as every other worker");
}

// ---- Part 3: real end-to-end proof that approval-gated execution still fails closed without a correlationId, driven through the worker itself ----

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
class RecordingTaskPlanner implements ITaskPlanner {
  public calls: Task[] = [];
  async run(task: Task, context?: TaskExecutionContext): Promise<TaskResult> {
    this.calls.push(task);
    return { taskType: task.type, correlationId: context?.correlationId ?? "unused", success: true };
  }
}
class RecordingTelegramClient implements ITelegramClient {
  public sentMessages: OutgoingMessage[] = [];
  async sendMessage(message: OutgoingMessage): Promise<void> {
    this.sentMessages.push(message);
  }
  async getUpdates(): Promise<TelegramUpdate[]> {
    throw new Error("not used");
  }
  async answerCallbackQuery(): Promise<void> {}
}
class FakeTelegramSecurity implements ITelegramSecurity {
  isAuthorized(): boolean {
    return true;
  }
}

async function verifyApprovalFailsClosedViaWorker(): Promise<void> {
  const telegramClient = new RecordingTelegramClient();
  const approvalProvider = new TelegramApprovalProvider(telegramClient, new FakeTelegramSecurity());

  const deferredEntryPoint = new DeferredControllerCore();
  const workflowRegistry = new WorkflowRegistry();
  const workflowOrchestrator = new WorkflowOrchestrator(deferredEntryPoint, workflowRegistry);
  const taskPlanner = new RecordingTaskPlanner();
  const repositoryRegistry = new FakeRepositoryRegistry([{ id: "alpha", name: "alpha", path: "/tmp/alpha", defaultBranch: "main", active: true }]);
  const plainControllerCore = new ControllerCore(repositoryRegistry, taskPlanner, workflowOrchestrator);
  const configService = new FakeConfigService({ mode: "manual", require_before_git_push: true, require_before_pull_request: true });
  const approvalEngine = new ApprovalEngine(plainControllerCore, configService, approvalProvider);
  deferredEntryPoint.bind(approvalEngine);

  const strategyEngine = new StrategyEngine(new FakeDecisionEngine(), new FakeContextBuilder(), new FakeSessionManager());
  const planningEngine = new PlanningEngine();
  const executionCoordinator = new ExecutionCoordinator();
  const executionPipeline = new ExecutionPipeline(new FakeRepositoryIntelligence(), strategyEngine, planningEngine, executionCoordinator, deferredEntryPoint);

  const scheduleProvider = new FakeScheduleProvider(schedulingReport([schedulingEntry({ repositoryId: "alpha", sourceRecommendationKind: "RepositoryReadyToShip" })]));
  const historyProvider = new FakeHistoryProvider([]); // nothing recent -- the worker will attempt
  const realOrchestrator = new AutonomousExecutionOrchestrator(scheduleProvider, executionPipeline); // real, unchanged Phase 11/12 class
  const worker = new AutonomousExecutionWorker(scheduleProvider, historyProvider, realOrchestrator, 20);

  worker.start();
  await delay(30); // one full tick, including the awaited (and immediately-rejected) approval check
  worker.stop();

  assert(telegramClient.sentMessages.length === 0, "no approval prompt is ever sent -- the worker supplies no correlationId, so TelegramApprovalProvider's own unmodified logic rejects the request before ever contacting a chat");
  assert(taskPlanner.calls.map((t) => t.type).join(",") === "verify-git-status,create-commit", "verify-git-status and create-commit still run for real; push-changes is denied (fail-closed) and nothing after it runs -- human approval is preserved, not bypassed");
}

async function main(): Promise<void> {
  await verifyWorkerBehaviorInIsolation();
  await verifyBackgroundRuntimeIntegration();
  await verifyApprovalFailsClosedViaWorker();
}

main();
