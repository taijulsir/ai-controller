import { describe, expect, it } from "vitest";
import type { IProjectMemoryService } from "../../memory/interfaces";
import type { ProjectMemoryEvent, TaskFailureState } from "../../memory/types";
import type { RepositorySnapshot } from "../../intelligence/types";
import type { IClaudeSessionManager } from "../../session/interfaces";
import { DecisionEngine } from "../DecisionEngine";
import type { Insight } from "../types";

function fakeSnapshot(): RepositorySnapshot {
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
  };
}

function fakeProjectMemory(overrides: {
  events?: ProjectMemoryEvent[];
  failureStates?: TaskFailureState[];
}): IProjectMemoryService {
  return {
    getRecentEvents: async () => overrides.events ?? [],
    getAllFailureStates: async () => overrides.failureStates ?? [],
    getFailureState: async (repositoryId, taskType) => (overrides.failureStates ?? []).find((s) => s.repositoryId === repositoryId && s.taskType === taskType),
    getMostRecentUndoableExecution: async () => undefined,
    recordUndo: async () => {},
    record: async () => {},
    recordTaskOutcome: async () => undefined as never,
    clearFailureState: async () => {},
    clearAllFailureStates: async () => {},
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

function failureState(taskType: string, consecutiveFailures: number): TaskFailureState {
  return {
    repositoryId: "repo-1",
    taskType: taskType as never,
    consecutiveFailures,
    blocked: consecutiveFailures >= 5,
  };
}

function repeatedFailureInsights(insights: Insight[]): Extract<Insight, { kind: "repeated-failures" }>[] {
  return insights.filter((insight): insight is Extract<Insight, { kind: "repeated-failures" }> => insight.kind === "repeated-failures");
}

describe("DecisionEngine — task-specific repeated-failure insights", () => {
  it("never produces an insight for an unrelated task type", async () => {
    const engine = new DecisionEngine(fakeProjectMemory({ failureStates: [failureState("sync", 5)] }), fakeSessionManager());
    const report = await engine.analyze(fakeSnapshot());
    const insights = repeatedFailureInsights(report.insights);
    expect(insights.some((i) => i.taskType === "sync")).toBe(true);
    expect(insights.some((i) => i.taskType === "implement-feature")).toBe(false);
  });

  it("is 'warning' at 2 consecutive failures and 'critical' at 5", async () => {
    const engineAtWarning = new DecisionEngine(fakeProjectMemory({ failureStates: [failureState("push-changes", 2)] }), fakeSessionManager());
    const warningReport = await engineAtWarning.analyze(fakeSnapshot());
    const warningInsight = repeatedFailureInsights(warningReport.insights).find((i) => i.taskType === "push-changes");
    expect(warningInsight?.severity).toBe("warning");

    const engineAtCritical = new DecisionEngine(fakeProjectMemory({ failureStates: [failureState("push-changes", 5)] }), fakeSessionManager());
    const criticalReport = await engineAtCritical.analyze(fakeSnapshot());
    const criticalInsight = repeatedFailureInsights(criticalReport.insights).find((i) => i.taskType === "push-changes");
    expect(criticalInsight?.severity).toBe("critical");
  });

  it("produces no insight below the warning threshold (1 consecutive failure)", async () => {
    const engine = new DecisionEngine(fakeProjectMemory({ failureStates: [failureState("fix-bug", 1)] }), fakeSessionManager());
    const report = await engine.analyze(fakeSnapshot());
    expect(repeatedFailureInsights(report.insights)).toHaveLength(0);
  });

  it("has no insight once the store reports a reset (consecutiveFailures: 0 after a success)", async () => {
    const engine = new DecisionEngine(fakeProjectMemory({ failureStates: [] }), fakeSessionManager());
    const report = await engine.analyze(fakeSnapshot());
    expect(repeatedFailureInsights(report.insights)).toHaveLength(0);
  });

  it("still derives workflow-keyed repeated-failures from the event log (unchanged path)", async () => {
    const events: ProjectMemoryEvent[] = [
      {
        id: "1",
        recordedAt: new Date(),
        repositoryId: "repo-1",
        outcome: {
          kind: "result",
          result: {
            kind: "workflow",
            workflowResult: { workflowId: "ship", correlationId: "c1", status: "failed", steps: [], startedAt: new Date(), completedAt: new Date(), durationMs: 1 },
            startedAt: new Date(),
            completedAt: new Date(),
            durationMs: 1,
          },
        },
      },
      {
        id: "2",
        recordedAt: new Date(),
        repositoryId: "repo-1",
        outcome: {
          kind: "result",
          result: {
            kind: "workflow",
            workflowResult: { workflowId: "ship", correlationId: "c2", status: "failed", steps: [], startedAt: new Date(), completedAt: new Date(), durationMs: 1 },
            startedAt: new Date(),
            completedAt: new Date(),
            durationMs: 1,
          },
        },
      },
    ];
    const engine = new DecisionEngine(fakeProjectMemory({ events, failureStates: [] }), fakeSessionManager());
    const report = await engine.analyze(fakeSnapshot());
    const workflowInsight = repeatedFailureInsights(report.insights).find((i) => i.workflowId === "ship");
    expect(workflowInsight?.occurrences).toBe(2);
    expect(workflowInsight?.taskType).toBeUndefined();
  });

  it("still fires a critical risky-situation insight when >=2 warnings/criticals co-occur", async () => {
    const engine = new DecisionEngine(
      fakeProjectMemory({ failureStates: [failureState("sync", 2), failureState("push-changes", 2)] }),
      fakeSessionManager(),
    );
    const report = await engine.analyze(fakeSnapshot());
    const risky = report.insights.find((i) => i.kind === "risky-situation");
    expect(risky?.severity).toBe("critical");
  });
});
