import { CommandParser } from "../src/telegram/CommandParser";
import { TelegramAdapter } from "../src/telegram/TelegramAdapter";
import { ResponseFormatter } from "../src/telegram/ResponseFormatter";
import { TelegramApprovalProvider } from "../src/telegram/TelegramApprovalProvider";
import { buildTelegramCorrelationId } from "../src/telegram/TelegramCorrelation";
import type {
  ITelegramClient,
  ITelegramSecurity,
  ITelegramCallbackHandler,
} from "../src/telegram/interfaces";
import type { IApplicationService } from "../src/application/interfaces";
import type { IAutonomousExecutionOrchestrator } from "../src/autonomousexecution/interfaces";
import { AutonomousExecutionOrchestrator } from "../src/autonomousexecution/AutonomousExecutionOrchestrator";
import type { IAutonomousPlanScheduleProvider } from "../src/application/interfaces";
import type { AutonomousPlanSchedulingEntry, AutonomousPlanSchedulingReport } from "../src/scheduling/types";
import type { IExecutionPipeline } from "../src/pipeline/interfaces";
import type { PipelineRequest, PipelineResult } from "../src/pipeline/types";
import { ExecutionPipeline } from "../src/pipeline/ExecutionPipeline";
import { ApprovalEngine } from "../src/approval/ApprovalEngine";
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
import type { OutgoingMessage, TelegramCallbackQuery, TelegramUpdate } from "../src/telegram/types";

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

// ---- Part 1: CommandParser recognizes the new command ----

function verifyCommandParser(): void {
  const parser = new CommandParser();

  const parsed = parser.parse("/auto-execute");
  assert(parsed.kind === "autonomous-execute", "\"/auto-execute\" parses to kind: \"autonomous-execute\"");

  const upper = parser.parse("/AUTO-EXECUTE");
  assert(upper.kind === "autonomous-execute", "the command is case-insensitive, matching every other command's own normalization");

  const withWhitespace = parser.parse("  /auto-execute  ");
  assert(withWhitespace.kind === "autonomous-execute", "surrounding whitespace is trimmed, same as every other command");

  const withIgnoredArgs = parser.parse("/auto-execute anything here");
  assert(withIgnoredArgs.kind === "autonomous-execute", "trailing text is ignored -- the command carries no data of its own, the orchestrator reads its own input");
}

// ---- Part 2: TelegramAdapter routes the command correctly ----

class RecordingOrchestrator implements IAutonomousExecutionOrchestrator {
  public calls: (string | undefined)[] = [];
  constructor(private readonly result: PipelineResult | undefined) {}
  async attemptExecution(correlationId?: string): Promise<PipelineResult | undefined> {
    this.calls.push(correlationId);
    return this.result;
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
  constructor(private readonly authorizedUserIds: Set<number>) {}
  isAuthorized(userId: number): boolean {
    return this.authorizedUserIds.has(userId);
  }
}

class UnusedExecutionPipeline implements IExecutionPipeline {
  async run(): Promise<PipelineResult> {
    throw new Error("not used -- the autonomous-execute command must never reach IExecutionPipeline directly, only through the orchestrator");
  }
}

class UnusedApplicationService {
  // Only a placeholder -- the autonomous-execute path must never touch
  // IApplicationService directly, only through the orchestrator's own
  // narrower IAutonomousPlanScheduleProvider dependency.
}

function cannedResult(completed: boolean): PipelineResult {
  return {
    path: "bypass",
    context: { task: { type: "verify-git-status" }, repositoryId: "alpha", repository: {} as RepositorySnapshot, generatedAt: new Date() },
    request: { kind: "task", task: { type: "verify-git-status" } },
    result: { kind: "task", taskResult: { success: completed, taskType: "verify-git-status", correlationId: "c" }, startedAt: new Date(), completedAt: new Date(), durationMs: 1 },
    completed,
  };
}

async function verifyTelegramAdapterRouting(): Promise<void> {
  const chatId = 12345;
  const userId = 999;
  const updateId = 42;

  // Authorized user -> the orchestrator is called with exactly the same
  // correlationId buildTelegramCorrelationId already produces for every
  // other execution-capable command.
  {
    const orchestrator = new RecordingOrchestrator(cannedResult(true));
    const telegramClient = new RecordingTelegramClient();
    const adapter = new TelegramAdapter(
      new UnusedExecutionPipeline(),
      new UnusedApplicationService() as unknown as IApplicationService,
      new FakeTelegramSecurity(new Set([userId])),
      telegramClient,
      orchestrator,
    );

    await adapter.handleUpdate({ updateId, message: { chatId, userId, text: "/auto-execute" } });

    assert(orchestrator.calls.length === 1, "an authorized \"/auto-execute\" command triggers exactly one attemptExecution() call");
    assert(orchestrator.calls[0] === buildTelegramCorrelationId(chatId, updateId), "the correlationId passed to attemptExecution() is built exactly as every other execution command already builds it");
    assert(telegramClient.sentMessages.length === 1 && telegramClient.sentMessages[0].chatId === chatId, "a single response is sent back to the triggering chat");
  }

  // Unauthorized user -> never reaches the orchestrator at all, same
  // authorization gate every other command already goes through.
  {
    const orchestrator = new RecordingOrchestrator(cannedResult(true));
    const telegramClient = new RecordingTelegramClient();
    const adapter = new TelegramAdapter(
      new UnusedExecutionPipeline(),
      new UnusedApplicationService() as unknown as IApplicationService,
      new FakeTelegramSecurity(new Set()), // nobody authorized
      telegramClient,
      orchestrator,
    );

    await adapter.handleUpdate({ updateId, message: { chatId, userId, text: "/auto-execute" } });

    assert(orchestrator.calls.length === 0, "an unauthorized user's \"/auto-execute\" never reaches the orchestrator");
    assert(telegramClient.sentMessages[0]?.text === "🚫 You are not authorized to use this bot.", "the standard authorization rejection message is sent, same as every other command");
  }

  // A failure inside attemptExecution() is caught and reported, same shape
  // as the existing task/workflow error handling.
  {
    class ThrowingOrchestrator implements IAutonomousExecutionOrchestrator {
      async attemptExecution(): Promise<PipelineResult | undefined> {
        throw new Error("boom");
      }
    }
    const telegramClient = new RecordingTelegramClient();
    const adapter = new TelegramAdapter(
      new UnusedExecutionPipeline(),
      new UnusedApplicationService() as unknown as IApplicationService,
      new FakeTelegramSecurity(new Set([userId])),
      telegramClient,
      new ThrowingOrchestrator(),
    );

    await adapter.handleUpdate({ updateId, message: { chatId, userId, text: "/auto-execute" } });
    assert(telegramClient.sentMessages[0]?.text === "⚠️ Something went wrong: boom", "a thrown error is caught and reported, exactly like the existing task/workflow path");
  }
}

// ---- Part 3: ResponseFormatter classifies outcomes correctly ----

function taskStep(taskType: Task["type"], success: boolean, approvalRequired?: boolean, error?: string) {
  return {
    stepId: taskType,
    taskType,
    executionResult: {
      kind: "task" as const,
      taskResult: { success, taskType, correlationId: "c", error },
      startedAt: new Date(),
      completedAt: new Date(),
      durationMs: 1,
      approval: approvalRequired === undefined ? undefined : { required: approvalRequired },
    },
  };
}

function shipPipelineResult(steps: ReturnType<typeof taskStep>[], overallCompleted: boolean): PipelineResult {
  const workflowResult = {
    workflowId: "ship",
    correlationId: "c",
    status: steps.every((s) => s.executionResult.taskResult.success) ? ("completed" as const) : ("failed" as const),
    steps,
    startedAt: new Date(),
    completedAt: new Date(),
    durationMs: 1,
  };
  return {
    path: "full",
    context: { task: { type: "create-commit", input: { message: "x" } }, repositoryId: "alpha", repository: {} as RepositorySnapshot, generatedAt: new Date() },
    strategy: { recommendedAction: "ShipChanges" } as PipelineResult extends { path: "full"; strategy: infer S } ? S : never,
    plan: {} as PipelineResult extends { path: "full"; plan: infer P } ? P : never,
    program: { repositoryId: "alpha", plan: {}, steps: [] } as PipelineResult extends { path: "full"; program: infer PR } ? PR : never,
    stepOutcomes: [{ status: "executed", capability: "IntegratedDelivery", request: { kind: "workflow", workflowId: "ship" }, result: { kind: "workflow", workflowResult, startedAt: new Date(), completedAt: new Date(), durationMs: 1 } }],
    completed: overallCompleted,
  };
}

function verifyResponseFormatter(): void {
  const formatter = new ResponseFormatter();

  assert(formatter.formatAutonomousExecutionResult(undefined) === "✅ Nothing eligible for autonomous execution right now.", "undefined -> the 'nothing eligible' message");

  const success = shipPipelineResult(
    [taskStep("verify-git-status", true, false), taskStep("create-commit", true, false), taskStep("push-changes", true, true), taskStep("create-pull-request", true, true)],
    true,
  );
  assert(formatter.formatAutonomousExecutionResult(success).startsWith("<b>🤖 Autonomous Execution Started</b>"), "a fully completed ship -> the 'execution started' message");

  const denied = shipPipelineResult(
    [taskStep("verify-git-status", true, false), taskStep("create-commit", true, false), taskStep("push-changes", false, true, "Rejected by Telegram user 1.")],
    false,
  );
  const deniedText = formatter.formatAutonomousExecutionResult(denied);
  assert(deniedText.startsWith("<b>⚠️ Approval Required</b>"), "an approval-gated step that was denied -> the 'approval required' message");
  assert(deniedText.includes("push-changes") && deniedText.includes("Rejected by Telegram user 1."), "the approval-required message names the exact step and carries the real rejection reason");

  const otherFailure = shipPipelineResult([taskStep("verify-git-status", false, false, "not a git repository")], false);
  const failureText = formatter.formatAutonomousExecutionResult(otherFailure);
  assert(failureText.startsWith("<b>❌ Autonomous Execution Failed</b>") && !failureText.startsWith("<b>⚠️ Approval Required</b>"), "a failure unrelated to approval -> the 'execution failed' message, distinct from 'approval required'");
}

// ---- Part 4: real end-to-end proof that Telegram approvals now complete ----

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

// A real ITelegramClient that, whenever an approval prompt is sent, plays
// the part of a human operator: extracts the correlationId from the
// keyboard's own callback data and immediately resolves it through the real
// TelegramApprovalProvider.handleCallback(), exactly as a real button tap
// would. Sending is the observable proxy for "a real approval prompt was
// actually issued" -- the whole point of this test.
class AutoDecidingTelegramClient implements ITelegramClient {
  public sentMessages: OutgoingMessage[] = [];
  public callbackHandler?: ITelegramCallbackHandler;
  constructor(private readonly decision: "approve" | "reject") {}
  async sendMessage(message: OutgoingMessage): Promise<void> {
    this.sentMessages.push(message);
    const approveButton = message.inlineKeyboard?.[0]?.find((b) => b.callbackData.startsWith("approval:approve:"));
    if (approveButton && this.callbackHandler) {
      const correlationId = approveButton.callbackData.slice("approval:approve:".length);
      const callbackQuery: TelegramCallbackQuery = { id: "cb", data: `approval:${this.decision}:${correlationId}`, chatId: message.chatId, userId: 1 };
      await this.callbackHandler.handleCallback(callbackQuery);
    }
  }
  async getUpdates(): Promise<TelegramUpdate[]> {
    throw new Error("not used");
  }
  async answerCallbackQuery(): Promise<void> {}
}

function buildRealChainWithTelegramApproval(approvalConfig: ControllerConfig["approval"], decision: "approve" | "reject") {
  const telegramClient = new AutoDecidingTelegramClient(decision);
  const telegramSecurity = new FakeTelegramSecurity(new Set([1]));
  const approvalProvider = new TelegramApprovalProvider(telegramClient, telegramSecurity);
  telegramClient.callbackHandler = approvalProvider;

  const deferredEntryPoint = new DeferredControllerCore();
  const workflowRegistry = new WorkflowRegistry();
  const workflowOrchestrator = new WorkflowOrchestrator(deferredEntryPoint, workflowRegistry);
  const taskPlanner = new RecordingTaskPlanner();
  const repositoryRegistry = new FakeRepositoryRegistry([{ id: "alpha", name: "alpha", path: "/tmp/alpha", defaultBranch: "main", active: true }]);
  const plainControllerCore = new ControllerCore(repositoryRegistry, taskPlanner, workflowOrchestrator);
  const configService = new FakeConfigService(approvalConfig);
  const approvalEngine = new ApprovalEngine(plainControllerCore, configService, approvalProvider);
  deferredEntryPoint.bind(approvalEngine);

  const strategyEngine = new StrategyEngine(new FakeDecisionEngine(), new FakeContextBuilder(), new FakeSessionManager());
  const planningEngine = new PlanningEngine();
  const executionCoordinator = new ExecutionCoordinator();
  const executionPipeline = new ExecutionPipeline(new FakeRepositoryIntelligence(), strategyEngine, planningEngine, executionCoordinator, deferredEntryPoint);

  const scheduleProvider = new FakeScheduleProvider(schedulingReport([schedulingEntry({ repositoryId: "alpha", sourceRecommendationKind: "RepositoryReadyToShip" })]));
  const orchestrator = new AutonomousExecutionOrchestrator(scheduleProvider, executionPipeline);

  return { orchestrator, taskPlanner, telegramClient };
}

async function verifyApprovalsNowCompleteViaTelegram(): Promise<void> {
  // Scenario 1: a real Telegram-shaped correlationId, approved -- the full
  // ship workflow, including two real approval round-trips, completes.
  {
    const { orchestrator, taskPlanner, telegramClient } = buildRealChainWithTelegramApproval(
      { mode: "manual", require_before_git_push: true, require_before_pull_request: true },
      "approve",
    );
    const correlationId = buildTelegramCorrelationId(555, 1);

    const result = await orchestrator.attemptExecution(correlationId);

    // TelegramApprovalProvider sends two messages per round-trip -- the
    // prompt itself (carries an inlineKeyboard) and, once decided, a plain
    // confirmation ("✅ Approved. Proceeding..."). Only the former is a real
    // approval *prompt*; filtering on inlineKeyboard is what actually proves
    // a prompt was issued, not just that some message was sent.
    const prompts = telegramClient.sentMessages.filter((m) => m.inlineKeyboard !== undefined);
    assert(prompts.length === 2, `two real approval prompts were actually sent (push-changes, create-pull-request) -- saw ${prompts.length} of ${telegramClient.sentMessages.length} total messages`);
    assert(telegramClient.sentMessages.every((m) => m.chatId === 555), "every message (prompts and confirmations) was sent to the exact chat that triggered the command");
    assert(taskPlanner.calls.map((t) => t.type).join(",") === "verify-git-status,create-commit,push-changes,create-pull-request", "all four shipWorkflow steps executed, in order");
    const shipStep = result?.path === "full" ? result.stepOutcomes.find((o) => o.status === "executed" && o.capability === "IntegratedDelivery") : undefined;
    const workflowStatus = shipStep && shipStep.status === "executed" && shipStep.result.kind === "workflow" ? shipStep.result.workflowResult.status : undefined;
    assert(workflowStatus === "completed", "Telegram approval now genuinely completes the ship workflow -- this is the fix this phase delivers");
  }

  // Scenario 2: a real Telegram-shaped correlationId, rejected -- a real
  // denial (not the old "correlationId was not created by the Telegram
  // transport" error), and the workflow stops there.
  {
    const { orchestrator, taskPlanner, telegramClient } = buildRealChainWithTelegramApproval(
      { mode: "manual", require_before_git_push: true, require_before_pull_request: true },
      "reject",
    );
    const correlationId = buildTelegramCorrelationId(555, 2);

    const result = await orchestrator.attemptExecution(correlationId);

    const prompts = telegramClient.sentMessages.filter((m) => m.inlineKeyboard !== undefined);
    assert(prompts.length === 1, `exactly one real approval prompt was sent, for push-changes -- saw ${prompts.length}`);
    assert(taskPlanner.calls.map((t) => t.type).join(",") === "verify-git-status,create-commit", "execution stops at the denied step -- create-pull-request is never attempted");
    const shipStep = result?.path === "full" ? result.stepOutcomes.find((o) => o.status === "executed" && o.capability === "IntegratedDelivery") : undefined;
    const failedStep = shipStep && shipStep.status === "executed" && shipStep.result.kind === "workflow" ? shipStep.result.workflowResult.failedStep : undefined;
    assert(
      failedStep?.executionResult.kind === "task" && failedStep.executionResult.taskResult.error === "Rejected by Telegram user 1.",
      "the denial is a real, human-attributed rejection -- not the 'correlationId was not created by the Telegram transport' error",
    );
  }

  // Scenario 3: correlationId omitted (Phase 11's exact original behavior,
  // for a non-Telegram caller) -- reproduces, on purpose, what every caller
  // experienced before this phase: TelegramApprovalProvider auto-rejects
  // with no prompt ever sent. This is not a regression; it's the documented
  // Phase 11 behavior, preserved exactly, now contrasted against Scenario 1.
  {
    const { orchestrator, taskPlanner, telegramClient } = buildRealChainWithTelegramApproval(
      { mode: "manual", require_before_git_push: true, require_before_pull_request: true },
      "approve",
    );

    const result = await orchestrator.attemptExecution(); // no correlationId

    assert(telegramClient.sentMessages.length === 0, "with no correlationId, no approval prompt is ever sent -- TelegramApprovalProvider's own unmodified logic rejects it immediately");
    assert(taskPlanner.calls.map((t) => t.type).join(",") === "verify-git-status,create-commit", "execution still stops at the (auto-rejected) push-changes step, exactly as it did before this phase");
    const shipStep = result?.path === "full" ? result.stepOutcomes.find((o) => o.status === "executed" && o.capability === "IntegratedDelivery") : undefined;
    const failedStep = shipStep && shipStep.status === "executed" && shipStep.result.kind === "workflow" ? shipStep.result.workflowResult.failedStep : undefined;
    assert(
      failedStep?.executionResult.kind === "task" && failedStep.executionResult.taskResult.error === "Cannot request Telegram approval: correlationId was not created by the Telegram transport.",
      "omitting correlationId reproduces the exact same rejection reason it always did -- Phase 11 behavior for non-Telegram callers is preserved byte-for-byte",
    );
  }

  // Scenario 4: approval not required by policy -- no correlationId needed
  // at all, no prompt, same as Phase 11.
  {
    const { orchestrator, taskPlanner, telegramClient } = buildRealChainWithTelegramApproval(
      { mode: "manual", require_before_git_push: false, require_before_pull_request: false },
      "approve",
    );

    await orchestrator.attemptExecution(buildTelegramCorrelationId(555, 3));

    assert(telegramClient.sentMessages.length === 0, "when policy does not require approval, no prompt is sent even with a valid correlationId supplied");
    assert(taskPlanner.calls.length === 4, "all four steps still run when approval is not required, exactly as Phase 11 already verified");
  }
}

async function main(): Promise<void> {
  verifyCommandParser();
  await verifyTelegramAdapterRouting();
  verifyResponseFormatter();
  await verifyApprovalsNowCompleteViaTelegram();
}

main();
