import { describe, expect, it } from "vitest";
import type { IDecisionEngine } from "../../decisions/interfaces";
import type { Insight, RepositoryInsightReport } from "../../decisions/types";
import type { IContextBuilder } from "../../context/interfaces";
import type { ExecutionContext } from "../../context/types";
import type { RepositorySnapshot } from "../../intelligence/types";
import type { Task } from "../../planner/types";
import type { IClaudeSessionManager } from "../../session/interfaces";
import { StrategyEngine } from "../StrategyEngine";

function fakeSnapshot(overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
  return {
    repository: { id: "repo-1", name: "repo-1", path: "/tmp/repo", defaultBranch: "main", active: true },
    branch: { current: "main", default: "main", ahead: 0, behind: 0 },
    branches: ["main"],
    workingTree: { isClean: true, staged: [], unstaged: [], untracked: [] },
    recentCommits: [],
    pullRequests: { open: [], openCount: 0 },
    health: { isGitRepository: true, isClean: true, hasUnpushedCommits: false, isBehindRemote: false, hasOpenPullRequests: false, issues: [] },
    workflowReadiness: { canShip: true, requiresApprovalBeforePush: false, requiresApprovalBeforePullRequest: false, blockers: [] },
    generatedAt: new Date(),
    ...overrides,
  };
}

function fakeDecisionEngine(insights: Insight[]): IDecisionEngine {
  return {
    analyze: async (snapshot): Promise<RepositoryInsightReport> => ({
      repositoryId: snapshot.repository.id,
      generatedAt: new Date(),
      insights,
      notificationWorthyInsights: insights.filter((i) => i.notificationWorthy),
    }),
  };
}

function fakeContextBuilder(): IContextBuilder {
  return {
    build: async (): Promise<ExecutionContext> => ({
      repository: fakeSnapshot(),
      recentHistory: [],
      relevantHistory: [],
      generatedAt: new Date(),
      warnings: [],
    }),
  };
}

function fakeSessionManager(): IClaudeSessionManager {
  return {
    resolveSession: () => undefined as never,
    resetSession: () => {},
    getSessionStatus: () => undefined,
    getIdleTimeoutMinutes: () => 30,
  };
}

function repeatedFailures(taskType: string, severity: Insight["severity"]): Insight {
  return { kind: "repeated-failures", severity, repositoryId: "repo-1", notificationWorthy: true, taskType, occurrences: 5 };
}

function riskySituation(): Insight {
  return { kind: "risky-situation", severity: "critical", repositoryId: "repo-1", notificationWorthy: true, contributingKinds: ["repeated-failures", "unclean-working-tree"] };
}

async function readiness(insights: Insight[], task: Task) {
  const engine = new StrategyEngine(fakeDecisionEngine(insights), fakeContextBuilder(), fakeSessionManager());
  const strategy = await engine.recommend({ task, repository: fakeSnapshot() });
  return strategy.executionReadiness;
}

describe("StrategyEngine — task-type-scoped execution readiness", () => {
  it("blocks sync when sync has a critical repeated-failures insight", async () => {
    const result = await readiness([repeatedFailures("sync", "critical")], { type: "sync" });
    expect(result.ready).toBe(false);
  });

  it("does NOT block implement-feature when only sync has a critical repeated-failures insight", async () => {
    const result = await readiness([repeatedFailures("sync", "critical")], { type: "implement-feature", input: { description: "x" } });
    expect(result.ready).toBe(true);
  });

  it("blocks push-changes only when push-changes itself has the critical insight", async () => {
    const blocked = await readiness([repeatedFailures("push-changes", "critical")], { type: "push-changes" });
    expect(blocked.ready).toBe(false);

    const unaffected = await readiness([repeatedFailures("push-changes", "critical")], { type: "fix-bug", input: { description: "x" } });
    expect(unaffected.ready).toBe(true);
  });

  it("blocks implement-feature only when implement-feature itself has the critical insight", async () => {
    const blocked = await readiness([repeatedFailures("implement-feature", "critical")], { type: "implement-feature", input: { description: "x" } });
    expect(blocked.ready).toBe(false);

    const unaffected = await readiness([repeatedFailures("implement-feature", "critical")], { type: "sync" });
    expect(unaffected.ready).toBe(true);
  });

  it("no longer blocks any task on a critical risky-situation insight alone (the core bug fix)", async () => {
    const result = await readiness([riskySituation()], { type: "implement-feature", input: { description: "x" } });
    expect(result.ready).toBe(true);
  });

  it("never blocks a READ_ONLY task type regardless of critical insights", async () => {
    const result = await readiness([repeatedFailures("analyze-repository", "critical"), riskySituation()], { type: "analyze-repository" });
    expect(result.ready).toBe(true);
  });

  it("still blocks push-changes/create-pull-request via workflowReadiness.blockers (unrelated safety path, untouched)", async () => {
    const engine = new StrategyEngine(fakeDecisionEngine([]), fakeContextBuilder(), fakeSessionManager());
    const snapshot = fakeSnapshot({ workflowReadiness: { canShip: false, requiresApprovalBeforePush: false, requiresApprovalBeforePullRequest: false, blockers: ["dirty tree"] } });
    const strategy = await engine.recommend({ task: { type: "push-changes" }, repository: snapshot });
    expect(strategy.executionReadiness.ready).toBe(false);
    expect(strategy.executionReadiness.blockers).toContain("dirty tree");
  });

  it("still blocks when the repository path is not a valid git repository (unrelated safety path, untouched)", async () => {
    const engine = new StrategyEngine(fakeDecisionEngine([]), fakeContextBuilder(), fakeSessionManager());
    const snapshot = fakeSnapshot({ health: { isGitRepository: false, isClean: true, hasUnpushedCommits: false, isBehindRemote: false, hasOpenPullRequests: false, issues: [] } });
    const strategy = await engine.recommend({ task: { type: "implement-feature", input: { description: "x" } }, repository: snapshot });
    expect(strategy.executionReadiness.ready).toBe(false);
  });
});
