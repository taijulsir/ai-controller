import type { IContextBuilder } from "../src/context/interfaces";
import type { ExecutionContext, ExecutionContextRequest } from "../src/context/types";
import type { IDecisionEngine } from "../src/decisions/interfaces";
import type { Insight, RepositoryInsightReport } from "../src/decisions/types";
import type { RepositorySnapshot } from "../src/intelligence/types";
import type { Task } from "../src/planner/types";
import type { IClaudeSessionManager } from "../src/session/interfaces";
import type { ClaudeSessionDecision, ClaudeSessionInfo } from "../src/session/types";
import { StrategyEngine } from "../src/strategy/StrategyEngine";

class FakeDecisionEngine implements IDecisionEngine {
  constructor(public insights: Insight[] = []) {}
  async analyze(snapshot: RepositorySnapshot): Promise<RepositoryInsightReport> {
    return {
      repositoryId: snapshot.repository.id,
      generatedAt: new Date(),
      insights: this.insights,
      notificationWorthyInsights: this.insights.filter((i) => i.notificationWorthy),
    };
  }
}

class FakeContextBuilder implements IContextBuilder {
  constructor(
    public relevantHistoryCount = 0,
    public warnings: string[] = [],
  ) {}
  async build(request: ExecutionContextRequest): Promise<ExecutionContext> {
    return {
      repository: request.repository,
      recentHistory: [],
      relevantHistory: Array.from({ length: this.relevantHistoryCount }),
      task: request.task,
      generatedAt: new Date(),
      warnings: this.warnings,
    } as ExecutionContext;
  }
}

class FakeSessionManager implements IClaudeSessionManager {
  constructor(public status: ClaudeSessionInfo | undefined = undefined) {}
  resolveSession(): ClaudeSessionDecision {
    throw new Error("StrategyEngine must not call resolveSession() — it has a mutating side effect");
  }
  resetSession(): void {}
  expireSession(): void {}
  getSessionStatus(): ClaudeSessionInfo | undefined {
    return this.status;
  }
}

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

function riskyInsight(): Insight {
  return { kind: "risky-situation", severity: "critical", repositoryId: "alpha", notificationWorthy: true, contributingKinds: ["unclean-working-tree", "stale-branch"] };
}

function warningInsight(): Insight {
  return { kind: "unclean-working-tree", severity: "warning", repositoryId: "alpha", notificationWorthy: true, staged: 1, unstaged: 2, untracked: 0 };
}

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

async function main(): Promise<void> {
  const implementTask: Task = { type: "implement-feature", input: { description: "add x" } };
  const pushTask: Task = { type: "push-changes" };
  const analyzeTask: Task = { type: "analyze-repository" };

  // Scenario 1: clean repo, no session, on default branch, implement-feature -> CreateFeatureBranch
  {
    const engine = new StrategyEngine(new FakeDecisionEngine([]), new FakeContextBuilder(0), new FakeSessionManager(undefined));
    const strategy = await engine.recommend({ task: implementTask, repository: baseSnapshot() });
    assert(strategy.recommendedAction === "CreateFeatureBranch", "fresh implement-feature on default branch -> CreateFeatureBranch");
    assert(strategy.sessionPolicy.action === "start-new" && strategy.sessionPolicy.reason === "no-active-session", "no session -> start-new/no-active-session");
    assert(strategy.executionPriority === "normal", "clean repo, no insights -> normal priority");
    assert(strategy.executionReadiness.ready === true, "clean repo -> ready");
  }

  // Scenario 2: active session, implement-feature -> ContinueCurrentTask
  {
    const activeSession: ClaudeSessionInfo = { id: "sess-1", repositoryId: "alpha", status: "active", createdAt: new Date(), lastUsedAt: new Date() };
    const engine = new StrategyEngine(new FakeDecisionEngine([]), new FakeContextBuilder(0), new FakeSessionManager(activeSession));
    const strategy = await engine.recommend({ task: implementTask, repository: baseSnapshot() });
    assert(strategy.recommendedAction === "ContinueCurrentTask", "active session + implement-feature -> ContinueCurrentTask");
    assert(strategy.sessionPolicy.action === "continue" && strategy.sessionPolicy.sessionId === "sess-1", "active session -> continue with correct id");
  }

  // Scenario 3: push-changes requiring approval -> WaitForApproval
  {
    const engine = new StrategyEngine(new FakeDecisionEngine([]), new FakeContextBuilder(0), new FakeSessionManager(undefined));
    const repository = baseSnapshot({ workflowReadiness: { canShip: true, requiresApprovalBeforePush: true, requiresApprovalBeforePullRequest: false, blockers: [] } });
    const strategy = await engine.recommend({ task: pushTask, repository });
    assert(strategy.recommendedAction === "WaitForApproval", "push-changes requiring approval -> WaitForApproval");
    assert(strategy.approvalExpectation.expected === true, "approvalExpectation.expected true when policy requires it");
  }

  // Scenario 4: not a git repository -> ReviewRepository, blocked, regardless of task
  {
    const engine = new StrategyEngine(new FakeDecisionEngine([]), new FakeContextBuilder(0), new FakeSessionManager(undefined));
    const repository = baseSnapshot({ health: { isGitRepository: false, isClean: false, hasUnpushedCommits: false, isBehindRemote: false, hasOpenPullRequests: false, issues: ["not a repo"] } });
    const strategy = await engine.recommend({ task: analyzeTask, repository });
    assert(strategy.recommendedAction === "ReviewRepository", "invalid git repo -> ReviewRepository even for analyze-repository");
    assert(strategy.executionPriority === "blocked", "invalid git repo -> blocked priority");
    assert(strategy.executionReadiness.ready === false, "invalid git repo -> not ready");
  }

  // Scenario 5: critical insight overrides an otherwise-fine task -> ReviewRepository
  {
    const engine = new StrategyEngine(new FakeDecisionEngine([riskyInsight()]), new FakeContextBuilder(0), new FakeSessionManager(undefined));
    const strategy = await engine.recommend({ task: implementTask, repository: baseSnapshot() });
    assert(strategy.recommendedAction === "ReviewRepository", "critical insight -> ReviewRepository overrides task-based recommendation");
    assert(strategy.safetyRecommendations.some((s) => s.insightKind === "risky-situation"), "critical insight surfaced in safetyRecommendations");
  }

  // Scenario 6: warning insight only -> elevated priority, still proceeds with task recommendation
  {
    const engine = new StrategyEngine(new FakeDecisionEngine([warningInsight()]), new FakeContextBuilder(0), new FakeSessionManager(undefined));
    const strategy = await engine.recommend({ task: analyzeTask, repository: baseSnapshot() });
    assert(strategy.executionPriority === "elevated", "warning insight -> elevated priority");
    assert(strategy.recommendedAction === "AnalyzeFirst", "warning insight doesn't block a non-shipping task's recommendation");
    assert(strategy.safetyRecommendations.length === 1, "warning insight surfaced exactly once in safetyRecommendations");
  }

  // Scenario 7: analyze-repository -> AnalyzeFirst; contextPolicy reflects relevant history
  {
    const engine = new StrategyEngine(new FakeDecisionEngine([]), new FakeContextBuilder(3, ["could not read recent history"]), new FakeSessionManager(undefined));
    const strategy = await engine.recommend({ task: analyzeTask, repository: baseSnapshot() });
    assert(strategy.recommendedAction === "AnalyzeFirst", "analyze-repository -> AnalyzeFirst");
    assert(strategy.contextPolicy.includeRelevantHistory === true && strategy.contextPolicy.relevantHistoryCount === 3, "contextPolicy reflects relevant history count");
    assert(strategy.contextPolicy.warnings.length === 1, "contextPolicy surfaces ContextBuilder warnings");
  }

  // Scenario 8: same RepositorySnapshot instance passed in flows unchanged into ContextBuilder
  {
    const repository = baseSnapshot();
    let observed: RepositorySnapshot | undefined;
    class ObservingContextBuilder implements IContextBuilder {
      async build(request: ExecutionContextRequest): Promise<ExecutionContext> {
        observed = request.repository;
        return { repository: request.repository, recentHistory: [], relevantHistory: [], task: request.task, generatedAt: new Date(), warnings: [] };
      }
    }
    const engine = new StrategyEngine(new FakeDecisionEngine([]), new ObservingContextBuilder(), new FakeSessionManager(undefined));
    await engine.recommend({ task: analyzeTask, repository });
    assert(observed === repository, "StrategyEngine passes the exact same RepositorySnapshot instance to ContextBuilder, no re-fetch");
  }
}

main();
