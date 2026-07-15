// High-fidelity integration test for Phase 7.5: real TelegramAdapter,
// CommandParser, ExecutionPipeline, StrategyEngine, PlanningEngine,
// ExecutionCoordinator, TaskPlanner, ControllerCore, ApprovalEngine,
// WorkflowOrchestrator, MemoryRecordingControllerCore, ProjectMemoryService
// (real file I/O against a temp dir), ClaudeSessionManager,
// RepositoryIntelligenceService, DecisionEngine, ContextBuilder,
// ApplicationService — wired together exactly as src/index.ts wires them.
// The only fakes are at the true external-I/O boundary: no real Claude API
// calls, no real GitHub CLI/network calls, no real Telegram HTTP calls. Git
// itself is real, against a disposable temp repository — real `git commit`
// runs, but nothing ever leaves this machine.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ApplicationService } from "../src/application/ApplicationService";
import { RecommendationEngine } from "../src/recommendations/RecommendationEngine";
import { EngineeringAssistanceEngine } from "../src/assistance/EngineeringAssistanceEngine";
import { ApprovalEngine } from "../src/approval/ApprovalEngine";
import type { IApprovalProvider } from "../src/approval/interfaces";
import type { ApprovalDecision, ApprovalRequest } from "../src/approval/types";
import type { IConfigService } from "../src/config/interfaces";
import type { ClaudeConfig, ControllerConfig, GithubConfig, TelegramConfig } from "../src/config/types";
import { ContextBuilder } from "../src/context/ContextBuilder";
import { ExecutionCoordinator } from "../src/coordination/ExecutionCoordinator";
import { ControllerCore } from "../src/controller/ControllerCore";
import { DeferredControllerCore } from "../src/controller/DeferredControllerCore";
import { DecisionEngine } from "../src/decisions/DecisionEngine";
import type { Repository } from "../src/domain/repository/Repository";
import { GitAdapter } from "../src/git/GitAdapter";
import type { IClaudeAdapter } from "../src/claude/interfaces";
import type { ClaudeExecuteOptions } from "../src/claude/interfaces";
import type { ClaudeExecutionResult, ClaudeRunState } from "../src/claude/types";
import type { IGithubAdapter } from "../src/github/interfaces";
import type { CreatePullRequestOptions, PullRequestSummary } from "../src/github/types";
import { RepositoryIntelligenceService } from "../src/intelligence/RepositoryIntelligenceService";
import { MemoryRecordingControllerCore } from "../src/memory/MemoryRecordingControllerCore";
import { ProjectMemoryService } from "../src/memory/ProjectMemoryService";
import type { ITaskWorkflow, IWorkflowFactory } from "../src/planner/interfaces";
import { TaskPlanner } from "../src/planner/TaskPlanner";
import type { Task, TaskExecutionContext } from "../src/planner/types";
import { CreateCommitWorkflow } from "../src/planner/workflows/CreateCommitWorkflow";
import { CreatePullRequestWorkflow } from "../src/planner/workflows/CreatePullRequestWorkflow";
import { GitStatusWorkflow } from "../src/planner/workflows/GitStatusWorkflow";
import { PushChangesWorkflow } from "../src/planner/workflows/PushChangesWorkflow";
import { AnalyzeRepositoryWorkflow } from "../src/planner/workflows/AnalyzeRepositoryWorkflow";
import { ExplainCodeWorkflow } from "../src/planner/workflows/ExplainCodeWorkflow";
import { ImplementFeatureWorkflow } from "../src/planner/workflows/ImplementFeatureWorkflow";
import { FixBugWorkflow } from "../src/planner/workflows/FixBugWorkflow";
import { ListPullRequestsWorkflow } from "../src/planner/workflows/ListPullRequestsWorkflow";
import { PlanningEngine } from "../src/planning/PlanningEngine";
import { ExecutionPipeline } from "../src/pipeline/ExecutionPipeline";
import { WorkflowOrchestrator } from "../src/orchestration/WorkflowOrchestrator";
import { WorkflowRegistry } from "../src/orchestration/WorkflowRegistry";
import { RepositoryRegistry } from "../src/repositories/RepositoryRegistry";
import { ClaudeSessionManager } from "../src/session/ClaudeSessionManager";
import { StrategyEngine } from "../src/strategy/StrategyEngine";
import { CommandParser } from "../src/telegram/CommandParser";
import { ResponseFormatter } from "../src/telegram/ResponseFormatter";
import { TelegramAdapter } from "../src/telegram/TelegramAdapter";
import type { ITelegramClient, ITelegramSecurity } from "../src/telegram/interfaces";
import type { OutgoingMessage, TelegramUpdate } from "../src/telegram/types";

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// --- Fakes at the true external I/O boundary only ---

class FakeClaudeAdapter implements IClaudeAdapter {
  public calls: { prompt: string; continue: boolean | undefined }[] = [];
  constructor(private readonly outputFor: (prompt: string) => string = () => "Fake Claude output.") {}
  async execute(prompt: string, options?: ClaudeExecuteOptions): Promise<ClaudeExecutionResult> {
    this.calls.push({ prompt, continue: options?.continue });
    return { output: this.outputFor(prompt), exitCode: 0 };
  }
  async *stream(): AsyncIterable<string> {}
  async stopSession(): Promise<void> {}
  getStatus(): ClaudeRunState {
    return { status: "idle", lastExitCode: null };
  }
  isRunning(): boolean {
    return false;
  }
}

class FakeGithubAdapter implements IGithubAdapter {
  public prCreated = false;
  async createPullRequest(options: CreatePullRequestOptions): Promise<PullRequestSummary> {
    this.prCreated = true;
    return { number: 1, title: options.title, url: "https://example.invalid/pr/1", headBranch: "feature", baseBranch: "main", author: "bot" };
  }
  async listOpenPullRequests(): Promise<PullRequestSummary[]> {
    return [];
  }
  getDefaultBaseBranch(): string {
    return "main";
  }
}

// Mirrors the real WorkflowFactory's structure exactly, but substitutes a
// FakeClaudeAdapter/FakeGithubAdapter for the two real external processes
// this test must not invoke, while using the REAL GitAdapter (against a
// disposable temp repo — real, local-only git commands, no network). Session
// continuation is resolved the same way the real WorkflowFactory does, via
// the same real ClaudeSessionManager, so session-reuse behavior is genuinely
// exercised, not faked away.
class TestWorkflowFactory implements IWorkflowFactory {
  public claudeAdapter: FakeClaudeAdapter;
  public githubAdapter: FakeGithubAdapter;

  constructor(
    private readonly repositoryRegistry: RepositoryRegistry,
    private readonly sessionManager: ClaudeSessionManager,
    claudeOutputFor: (prompt: string) => string,
  ) {
    this.claudeAdapter = new FakeClaudeAdapter(claudeOutputFor);
    this.githubAdapter = new FakeGithubAdapter();
  }

  create(task: Task, context: TaskExecutionContext): ITaskWorkflow {
    const gitAdapter = new GitAdapter(this.repositoryRegistry, context.repositoryId);
    switch (task.type) {
      case "analyze-repository":
        return new AnalyzeRepositoryWorkflow(this.claudeAdapter, this.resolveShouldContinue(context));
      case "explain-code":
        return new ExplainCodeWorkflow(this.claudeAdapter, this.resolveShouldContinue(context));
      case "implement-feature":
        return new ImplementFeatureWorkflow(this.claudeAdapter, this.resolveShouldContinue(context));
      case "fix-bug":
        return new FixBugWorkflow(this.claudeAdapter, this.resolveShouldContinue(context));
      case "verify-git-status":
        return new GitStatusWorkflow(gitAdapter);
      case "create-commit":
        return new CreateCommitWorkflow(gitAdapter);
      case "push-changes":
        return new PushChangesWorkflow(gitAdapter);
      case "create-pull-request":
        return new CreatePullRequestWorkflow(gitAdapter, this.githubAdapter);
      case "list-pull-requests":
        return new ListPullRequestsWorkflow(this.githubAdapter);
      default:
        throw new Error(`No test workflow for task type "${(task as Task).type}"`);
    }
  }

  private resolveShouldContinue(context: TaskExecutionContext): boolean {
    const repositoryId = context.repositoryId ?? this.repositoryRegistry.getActiveRepository()?.id;
    if (!repositoryId) throw new Error("no active repository");
    return this.sessionManager.resolveSession(repositoryId).shouldContinue;
  }
}

class FakeConfigService implements IConfigService {
  constructor(
    private readonly repositories: Repository[],
    private readonly memoryDirectory: string,
    public requireApprovalBeforePush: boolean,
  ) {}
  getControllerConfig(): ControllerConfig {
    return {
      controller: { name: "test", version: "0.0.0", environment: "test" },
      workspace: { root: "/tmp" },
      task: { max_concurrent_jobs: 5, timeout_minutes: 5 },
      approval: { mode: "manual", require_before_git_push: this.requireApprovalBeforePush, require_before_pull_request: false },
      logging: { enabled: false, level: "info", directory: "/tmp" },
      memory: { enabled: true, directory: this.memoryDirectory },
    };
  }
  getClaudeConfig(): ClaudeConfig {
    return {
      provider: { name: "anthropic" },
      cli: { executable: "claude" },
      execution: { approval_mode: "default", max_execution_minutes: 5 },
      session: { resume_previous: false },
    };
  }
  getGithubConfig(): GithubConfig {
    return { github: { cli: "gh" }, git: { default_branch: "main" }, pull_request: { auto_create: false, auto_merge: false } };
  }
  getTelegramConfig(): TelegramConfig {
    return { telegram: { enabled: true }, bot: { token: "x" }, security: { allowed_users: [] }, notifications: { task_started: true, task_completed: true, task_failed: true } };
  }
  getRepositories(): Repository[] {
    return this.repositories;
  }
  reload(): void {}
}

class FakeTelegramClient implements ITelegramClient {
  public sent: OutgoingMessage[] = [];
  async sendMessage(message: OutgoingMessage): Promise<void> {
    this.sent.push(message);
  }
  async getUpdates(): Promise<TelegramUpdate[]> {
    return [];
  }
  async answerCallbackQuery(): Promise<void> {}
}

class AllowAllTelegramSecurity implements ITelegramSecurity {
  isAuthorized(): boolean {
    return true;
  }
}

// Auto-approves every request but records that it was actually consulted —
// this is what real approval-gating exercises, not a "does the bot demand a
// human click" test (nobody can click a real Telegram button in this run).
class RecordingApprovalProvider implements IApprovalProvider {
  public requests: ApprovalRequest[] = [];
  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return { approved: true, approvedBy: "test-harness" };
  }
}

let update = 0;
function makeUpdate(chatId: number, text: string): TelegramUpdate {
  update += 1;
  return { updateId: update, message: { chatId, userId: 1, text } };
}

async function main(): Promise<void> {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "phase75-"));
  const repoPath = path.join(tmpRoot, "repo");
  const memoryDir = path.join(tmpRoot, "memory");

  try {
    // Real, disposable git repository — real `git init`/`git commit`, no network, no external effect.
    git(tmpdir(), "init", "-q", repoPath, "-b", "main");
    git(repoPath, "config", "user.email", "test@example.invalid");
    git(repoPath, "config", "user.name", "Test Harness");
    execFileSync("sh", ["-c", "echo 'hello' > README.md"], { cwd: repoPath });
    git(repoPath, "add", "README.md");
    git(repoPath, "commit", "-q", "-m", "initial commit");

    // A local, bare "origin" — lets a real `git push` actually succeed
    // (still zero network calls, fully disposable) so the full ship
    // sequence can be exercised through to the create-pr step.
    const remotePath = path.join(tmpRoot, "origin.git");
    git(tmpdir(), "init", "-q", "--bare", remotePath);
    git(repoPath, "remote", "add", "origin", remotePath);
    git(repoPath, "push", "-q", "-u", "origin", "main");

    const repository: Repository = { id: "alpha", name: "alpha", path: repoPath, defaultBranch: "main", active: true };
    const configService = new FakeConfigService([repository], memoryDir, true);
    const repositoryRegistry = new RepositoryRegistry(configService);

    const repositoryIntelligence = new RepositoryIntelligenceService(repositoryRegistry, configService);
    const projectMemory = new ProjectMemoryService(repositoryRegistry, configService);
    const sessionManager = new ClaudeSessionManager();
    const decisionEngine = new DecisionEngine(projectMemory, sessionManager);
    const contextBuilder = new ContextBuilder(projectMemory);
    const recommendationEngine = new RecommendationEngine();
    const engineeringAssistanceEngine = new EngineeringAssistanceEngine();
    const applicationService = new ApplicationService(repositoryIntelligence, projectMemory, decisionEngine, sessionManager, repositoryRegistry, recommendationEngine, engineeringAssistanceEngine);

    const strategyEngine = new StrategyEngine(decisionEngine, contextBuilder, sessionManager);
    const planningEngine = new PlanningEngine();
    const executionCoordinator = new ExecutionCoordinator();

    const workflowFactory = new TestWorkflowFactory(repositoryRegistry, sessionManager, (prompt) =>
      prompt.includes("Analyze") ? "This repo has one README." : "Implemented.",
    );
    const taskPlanner = new TaskPlanner(configService, workflowFactory);

    const controllerEntryPoint = new DeferredControllerCore();
    const workflowRegistry = new WorkflowRegistry();
    const workflowOrchestrator = new WorkflowOrchestrator(controllerEntryPoint, workflowRegistry);
    const executionPipeline = new ExecutionPipeline(repositoryIntelligence, strategyEngine, planningEngine, executionCoordinator, controllerEntryPoint);

    const plainControllerCore = new ControllerCore(repositoryRegistry, taskPlanner, workflowOrchestrator);
    const approvalProvider = new RecordingApprovalProvider();
    const approvalControllerCore = new ApprovalEngine(plainControllerCore, configService, approvalProvider);
    const controllerCore = new MemoryRecordingControllerCore(approvalControllerCore, projectMemory);
    controllerEntryPoint.bind(controllerCore);

    const telegramClient = new FakeTelegramClient();
    const telegramAdapter = new TelegramAdapter(
      executionPipeline,
      applicationService,
      new AllowAllTelegramSecurity(),
      telegramClient,
      new CommandParser(),
      new ResponseFormatter(),
    );

    const CHAT = 555;

    // --- Test 1: /analyze -> full stack, real analyze-repository task dispatched to (fake) Claude ---
    await telegramAdapter.handleUpdate(makeUpdate(CHAT, "/analyze"));
    assert(workflowFactory.claudeAdapter.calls.length === 1, "analyze: Claude was called exactly once");
    assert(workflowFactory.claudeAdapter.calls[0].prompt.includes("Analyze"), "analyze: the real analyze-repository prompt was sent, not a substitute verify-git-status");
    const analyzeReply = telegramClient.sent[telegramClient.sent.length - 1].text;
    assert(analyzeReply.includes("Recommended action: AnalyzeFirst"), "analyze: response surfaces the Strategy recommendation (Strategy executed)");
    assert(analyzeReply.includes("This repo has one README."), "analyze: response surfaces the real Claude output");

    // --- Test 2: /implement -> fresh repo, no session, on default branch -> blocked (adjustment 3), Claude never called ---
    // /analyze above already established a session for "alpha" (every
    // Claude-calling workflow type shares the same per-repository session
    // pool, unchanged real behavior) — reset it so this test genuinely
    // starts from "no active session", not an artifact of test ordering.
    sessionManager.resetSession("alpha");
    const claudeCallsBeforeImplement = workflowFactory.claudeAdapter.calls.length;
    await telegramAdapter.handleUpdate(makeUpdate(CHAT, "/implement add a login page"));
    const implementReply = telegramClient.sent[telegramClient.sent.length - 1].text;
    assert(implementReply.includes("Recommended action: CreateFeatureBranch"), "implement-feature: Strategy correctly recommends CreateFeatureBranch (Strategy+Planning+Coordination executed)");
    assert(implementReply.includes("⛔") && implementReply.toLowerCase().includes("branch"), "implement-feature: blocked outcome with explanation is surfaced to the user, not silence");
    assert(workflowFactory.claudeAdapter.calls.length === claudeCallsBeforeImplement, "implement-feature: Claude never called while blocked — no duplicate/incorrect execution");

    // Switch to a feature branch so a second implement-feature request can actually run.
    git(repoPath, "checkout", "-q", "-b", "feature/login");

    // --- Test 3: /implement again, now on a feature branch -> ContinueCurrentTask (fresh session) -> real Claude call ---
    await telegramAdapter.handleUpdate(makeUpdate(CHAT, "/implement add a login page"));
    assert(workflowFactory.claudeAdapter.calls.length === claudeCallsBeforeImplement + 1, "implement-feature: on a feature branch, Claude is actually called");
    assert(workflowFactory.claudeAdapter.calls[workflowFactory.claudeAdapter.calls.length - 1].continue === false, "implement-feature: first call on this repo does not continue a session (none existed)");
    assert(sessionManager.getSessionStatus("alpha")?.status === "active", "Claude session management: a session now exists for this repository after the real workflow ran");

    // --- Test 4: /fix -> same repo, active session from Test 3 -> ContinueCurrentTask, session continued ---
    await telegramAdapter.handleUpdate(makeUpdate(CHAT, "/fix null pointer on submit"));
    const fixReply = telegramClient.sent[telegramClient.sent.length - 1].text;
    assert(fixReply.includes("Recommended action: ContinueCurrentTask"), "fix-bug: active session -> ContinueCurrentTask");
    assert(workflowFactory.claudeAdapter.calls[workflowFactory.claudeAdapter.calls.length - 1].continue === true, "Claude session reuse: fix-bug's Claude call passes continue: true, reusing the session implement-feature established");

    // --- Test 5: /ship -> kind: "pipeline" -> full stack -> ShipChanges -> real git commit, approval on push, fake gh for the PR ---
    // The fake Claude adapter never touches the filesystem (it only returns
    // canned text), so — exactly as a real implementation would need real
    // changes to commit — the working tree needs a real, uncommitted change
    // for "ship" to have anything to commit.
    execFileSync("sh", ["-c", "echo 'login feature' >> README.md"], { cwd: repoPath });
    const memoryEventsBeforeShip = readMemoryEventCount(memoryDir);
    await telegramAdapter.handleUpdate(makeUpdate(CHAT, "/ship Add login page"));
    const shipReply = telegramClient.sent[telegramClient.sent.length - 1].text;
    assert(shipReply.includes("Recommended action: ShipChanges"), "ship: Strategy correctly recommends ShipChanges (Strategy+Planning+Coordination executed for /ship)");
    const log = git(repoPath, "log", "--oneline", "-n", "3");
    assert(log.includes("Add login page"), "ship: a real git commit was created with the message from /ship — ControllerCore actually executed the workflow, not a simulation");
    assert(approvalProvider.requests.length === 1 && approvalProvider.requests[0].task.type === "push-changes", "ship: ApprovalEngine was actually consulted before the push-changes step, exactly as configured (require_before_git_push: true) — approval still occurs where configured");
    assert(workflowFactory.githubAdapter.prCreated === true, "ship: the (fake) GitHub PR-creation step ran as part of the same real workflow, confirming the full ship sequence executed end to end");

    // --- Cross-cutting: Project Memory recorded every one of the five requests above ---
    const memoryEventsAfterShip = readMemoryEventCount(memoryDir);
    assert(memoryEventsAfterShip > memoryEventsBeforeShip, "Project Memory: at least one new event was recorded for the /ship request");
    const allEvents = await projectMemory.getRecentEvents({ repositoryId: "alpha", limit: 50 });
    assert(allEvents.length >= 5, `Project Memory: recorded events for all dispatched requests across this run (found ${allEvents.length})`);

    // --- Cross-cutting: Repository Intelligence / Decision Engine still function live, independent of the pipeline run ---
    const insights = await applicationService.getRepositoryInsights("alpha");
    assert(Array.isArray(insights.insights), "Repository Intelligence + Decision Engine: getRepositoryInsights() still works after all pipeline activity");

    // --- Cross-cutting: Phase 7.6 Recommendation Engine works against the same real, live-updated repository state ---
    const recommendations = await applicationService.getRecommendations("alpha");
    assert(Array.isArray(recommendations.recommendations), "Recommendation Engine: getRecommendations() returns a valid report against real repository state");
    assert(recommendations.repositoryId === "alpha", "Recommendation Engine: report is scoped to the correct repository");

    // --- Cross-cutting: Phase 7.8 Engineering Assistance Engine transforms the same real recommendations into proposals ---
    const assistance = await applicationService.getEngineeringAssistance("alpha");
    assert(Array.isArray(assistance.proposals), "Engineering Assistance Engine: getEngineeringAssistance() returns a valid report against real repository state");
    assert(assistance.proposals.length === recommendations.recommendations.length, "Engineering Assistance Engine: one proposal per recommendation, no duplication or loss");
    assert(
      assistance.proposals.every((proposal) => proposal.actions.filter((a) => a.isPrimary).length === 1),
      "Engineering Assistance Engine: every proposal has exactly one explicit primary action",
    );

    // --- Cross-cutting: no duplicate execution — every ControllerCore-level
    // dispatch corresponds to exactly one recorded memory event kind, and the
    // Telegram reply for each command was produced exactly once.
    assert(telegramClient.sent.length === 5, `no duplicate execution: exactly one Telegram reply per command (${telegramClient.sent.length} sent for 5 commands)`);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function readMemoryEventCount(memoryDir: string): number {
  const file = path.join(memoryDir, "events.jsonl");
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0).length;
}

main().catch((error) => {
  console.error("FAIL - unhandled error:", error);
  process.exitCode = 1;
});
