import { validateTelegramConfig } from "../src/config/validators";
import { buildTelegramCorrelationId, parseTelegramCorrelationId } from "../src/telegram/TelegramCorrelation";
import { AutonomousExecutionWorker } from "../src/runtime/AutonomousExecutionWorker";
import { AutonomousExecutionOrchestrator } from "../src/autonomousexecution/AutonomousExecutionOrchestrator";
import type { IAutonomousExecutionOrchestrator } from "../src/autonomousexecution/interfaces";
import type { PipelineResult } from "../src/pipeline/types";
import type { IAutonomousPlanScheduleProvider } from "../src/application/interfaces";
import type { IRecentExecutionHistoryProvider } from "../src/memory/interfaces";
import type { ProjectMemoryEvent } from "../src/memory/types";
import type { AutonomousPlanSchedulingEntry, AutonomousPlanSchedulingReport } from "../src/scheduling/types";
import { ExecutionPipeline } from "../src/pipeline/ExecutionPipeline";
import { ApprovalEngine } from "../src/approval/ApprovalEngine";
import { TelegramApprovalProvider } from "../src/telegram/TelegramApprovalProvider";
import type { ITelegramClient, ITelegramSecurity, ITelegramCallbackHandler } from "../src/telegram/interfaces";
import type { OutgoingMessage, TelegramCallbackQuery, TelegramUpdate } from "../src/telegram/types";
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
  constructor(private readonly report: AutonomousPlanSchedulingReport) {}
  async getAutonomousPlanSchedule(): Promise<AutonomousPlanSchedulingReport> {
    return this.report;
  }
}
class FakeHistoryProvider implements IRecentExecutionHistoryProvider {
  async getRecentEvents(): Promise<ProjectMemoryEvent[]> {
    return []; // nothing recent -- every worker tick in this file is free to attempt
  }
}

// ---- Part 1: config validation accepts the new optional field correctly ----

function verifyConfigValidation(): void {
  const validBase = {
    telegram: { enabled: true },
    bot: { token: "x" },
    security: { allowed_users: ["1"] },
    notifications: { task_started: true, task_completed: true, task_failed: true },
  };

  const withoutOperatorChat = validateTelegramConfig(validBase, "telegram.yaml");
  assert(withoutOperatorChat.telegram.operator_chat_id === undefined, "operator_chat_id absent from config -> validated config carries it as undefined, not rejected");

  const withOperatorChat = validateTelegramConfig({ ...validBase, telegram: { ...validBase.telegram, operator_chat_id: 555 } }, "telegram.yaml");
  assert(withOperatorChat.telegram.operator_chat_id === 555, "a numeric operator_chat_id is accepted and carried through exactly");

  let threw = false;
  try {
    validateTelegramConfig({ ...validBase, telegram: { ...validBase.telegram, operator_chat_id: "not-a-number" } }, "telegram.yaml");
  } catch {
    threw = true;
  }
  assert(threw, "a non-numeric operator_chat_id is rejected by validation, same as every other misconfigured field");
}

// ---- Part 2: buildTelegramCorrelationId output round-trips through the existing, unmodified parser ----

function verifyCorrelationIdRoundTrip(): void {
  const correlationId = buildTelegramCorrelationId(555, 0);
  const parsed = parseTelegramCorrelationId(correlationId);
  assert(parsed?.chatId === 555 && parsed?.updateId === 0, "a correlationId built from an operator chat id round-trips through the existing, unmodified TelegramCorrelation parser exactly like a real Telegram-derived one would");
}

// ---- Part 3: real end-to-end chain (mirrors Phase 12/13's own harness) ----

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
  public callbackHandler?: ITelegramCallbackHandler;
  constructor(private readonly autoDecision?: "approve" | "reject") {}
  async sendMessage(message: OutgoingMessage): Promise<void> {
    this.sentMessages.push(message);
    if (!this.autoDecision) return;
    const approveButton = message.inlineKeyboard?.[0]?.find((b) => b.callbackData.startsWith("approval:approve:"));
    if (approveButton && this.callbackHandler) {
      const correlationId = approveButton.callbackData.slice("approval:approve:".length);
      const callbackQuery: TelegramCallbackQuery = { id: "cb", data: `approval:${this.autoDecision}:${correlationId}`, chatId: message.chatId, userId: 1 };
      await this.callbackHandler.handleCallback(callbackQuery);
    }
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

function buildRealChain(operatorChatId: number | undefined, autoDecision?: "approve" | "reject") {
  const telegramClient = new RecordingTelegramClient(autoDecision);
  const approvalProvider = new TelegramApprovalProvider(telegramClient, new FakeTelegramSecurity());
  telegramClient.callbackHandler = approvalProvider;

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
  const historyProvider = new FakeHistoryProvider();
  const orchestrator = new AutonomousExecutionOrchestrator(scheduleProvider, executionPipeline);

  // Mirrors exactly how src/index.ts computes it: undefined when
  // operator_chat_id is not configured, buildTelegramCorrelationId()
  // otherwise -- the same, unmodified function, used the same way.
  const correlationId = operatorChatId !== undefined ? buildTelegramCorrelationId(operatorChatId, 0) : undefined;
  const worker = new AutonomousExecutionWorker(scheduleProvider, historyProvider, orchestrator, 20, correlationId);

  return { worker, telegramClient, taskPlanner };
}

async function verifyConfiguredOperatorChat(): Promise<void> {
  const OPERATOR_CHAT_ID = 555;
  const { worker, telegramClient, taskPlanner } = buildRealChain(OPERATOR_CHAT_ID, "approve");

  worker.start();
  await delay(30); // one full tick, including two full approval round-trips
  worker.stop();

  // ---- approval prompt delivery ----
  const prompts = telegramClient.sentMessages.filter((m) => m.inlineKeyboard !== undefined);
  assert(prompts.length === 2, `two real approval prompts (push-changes, create-pull-request) are delivered when an operator chat is configured (saw ${prompts.length})`);
  assert(prompts.every((m) => m.chatId === OPERATOR_CHAT_ID), "every prompt is delivered to the exact configured operator chat, not any other chat");

  // ---- approval flow completion ----
  assert(taskPlanner.calls.map((t) => t.type).join(",") === "verify-git-status,create-commit,push-changes,create-pull-request", "with the operator chat configured and each prompt approved, the full shipWorkflow completes, in order");
}

async function verifyUnconfiguredFallback(): Promise<void> {
  const { worker, telegramClient, taskPlanner } = buildRealChain(undefined); // operator_chat_id not configured

  worker.start();
  await delay(30);
  worker.stop();

  assert(telegramClient.sentMessages.length === 0, "unconfigured operator chat -> no approval prompt is ever sent, TelegramApprovalProvider's own unmodified logic denies before contacting any chat");
  assert(taskPlanner.calls.map((t) => t.type).join(",") === "verify-git-status,create-commit", "unconfigured operator chat -> execution still stops at the (denied) push-changes step, exactly as Phase 13 built it");
}

async function verifyRegressionAgainstPhase13(): Promise<void> {
  // The exact Phase 13 construction shape (3 required args only) must still
  // compile and behave identically -- correlationId's absence here is not
  // "explicitly passed as undefined", it's simply omitted, the same as every
  // pre-Phase-14 call site in verify-autonomous-execution-worker.ts.
  const scheduleProvider = new FakeScheduleProvider(schedulingReport([schedulingEntry({ repositoryId: "alpha", sourceRecommendationKind: "RepositoryReadyToShip" })]));
  const historyProvider = new FakeHistoryProvider();
  class RecordingOrchestrator implements IAutonomousExecutionOrchestrator {
    calls: (string | undefined)[] = [];
    async attemptExecution(correlationId?: string): Promise<PipelineResult | undefined> {
      this.calls.push(correlationId);
      return undefined;
    }
  }
  const orchestrator = new RecordingOrchestrator();
  const worker = new AutonomousExecutionWorker(scheduleProvider, historyProvider, orchestrator, 20);

  worker.start();
  await delay(30);
  worker.stop();

  assert(orchestrator.calls.length >= 1, "the original 4-argument Phase 13 construction (no correlationId at all) still works, unmodified");
  assert(orchestrator.calls.every((c) => c === undefined), "and still supplies no correlationId, exactly as Phase 13 behaved before this phase existed");
}

async function main(): Promise<void> {
  verifyConfigValidation();
  verifyCorrelationIdRoundTrip();
  await verifyConfiguredOperatorChat();
  await verifyUnconfiguredFallback();
  await verifyRegressionAgainstPhase13();
}

main();
