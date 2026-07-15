import type { RepositorySnapshot } from "../intelligence/types";
import type { IProjectMemoryService } from "../memory/interfaces";
import type { ProjectMemoryEvent } from "../memory/types";
import type { IClaudeSessionManager } from "../session/interfaces";
import type { ClaudeSessionInfo } from "../session/types";
import type { IDecisionEngine } from "./interfaces";
import type { Insight, RepositoryInsightReport } from "./types";

// Kept internal for now; promote to config/controller.yaml if a future
// frontend needs these tunable, same precedent as prior phases' constants.
const STALE_BRANCH_BEHIND_THRESHOLD = 5;
const STALE_COMMIT_AGE_DAYS = 14;
const REPEATED_FAILURE_THRESHOLD = 2;
const RISKY_SITUATION_MIN_WARNINGS = 2;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class DecisionEngine implements IDecisionEngine {
  constructor(
    private readonly projectMemory: IProjectMemoryService,
    private readonly sessionManager: IClaudeSessionManager,
  ) {}

  // Reasons entirely from the RepositorySnapshot it's given — it no longer
  // fetches one itself. Callers (StrategyEngine as part of the autonomous
  // pipeline, or ApplicationService for the standalone /insights command)
  // own resolving the snapshot exactly once and passing it in, so every
  // consumer of a given snapshot reasons about identical repository state.
  async analyze(snapshot: RepositorySnapshot): Promise<RepositoryInsightReport> {
    const repositoryId = snapshot.repository.id;
    const recentHistory = await this.projectMemory.getRecentEvents({ repositoryId });
    const sessionInfo = this.sessionManager.getSessionStatus(repositoryId);

    const insights: Insight[] = [
      ...this.detectWorkingTreeInsights(repositoryId, snapshot),
      ...this.detectUnpushedCommitsInsight(repositoryId, snapshot),
      ...this.detectStaleBranchInsight(repositoryId, snapshot),
      ...this.detectUnfinishedWorkflowInsights(repositoryId, recentHistory),
      ...this.detectRepeatedFailureInsights(repositoryId, recentHistory),
      ...this.detectApprovalInsights(repositoryId, snapshot),
      ...this.detectOpenPullRequestsInsight(repositoryId, snapshot),
      ...this.detectSessionInsight(repositoryId, sessionInfo),
    ];
    insights.push(...this.detectRiskySituation(repositoryId, insights));

    return {
      repositoryId,
      generatedAt: new Date(),
      insights,
      notificationWorthyInsights: insights.filter((insight) => insight.notificationWorthy),
    };
  }

  private detectWorkingTreeInsights(repositoryId: string, snapshot: RepositorySnapshot): Insight[] {
    if (snapshot.workingTree.isClean) {
      return [];
    }
    return [
      {
        kind: "unclean-working-tree",
        severity: "warning",
        repositoryId,
        notificationWorthy: true,
        staged: snapshot.workingTree.staged.length,
        unstaged: snapshot.workingTree.unstaged.length,
        untracked: snapshot.workingTree.untracked.length,
      },
    ];
  }

  private detectUnpushedCommitsInsight(repositoryId: string, snapshot: RepositorySnapshot): Insight[] {
    if (snapshot.branch.ahead <= 0) {
      return [];
    }
    return [
      {
        kind: "unpushed-commits",
        severity: "info",
        repositoryId,
        notificationWorthy: false,
        ahead: snapshot.branch.ahead,
      },
    ];
  }

  private detectStaleBranchInsight(repositoryId: string, snapshot: RepositorySnapshot): Insight[] {
    const lastCommitAt = snapshot.recentCommits[0]?.date;
    const ageDays = lastCommitAt ? (Date.now() - lastCommitAt.getTime()) / MS_PER_DAY : undefined;
    const isBehindThreshold = snapshot.branch.behind > STALE_BRANCH_BEHIND_THRESHOLD;
    const isStaleByAge = ageDays !== undefined && ageDays > STALE_COMMIT_AGE_DAYS;

    if (!isBehindThreshold && !isStaleByAge) {
      return [];
    }

    return [
      {
        kind: "stale-branch",
        severity: "warning",
        repositoryId,
        notificationWorthy: true,
        branch: snapshot.branch.current,
        behind: snapshot.branch.behind,
        lastCommitAt,
      },
    ];
  }

  private detectUnfinishedWorkflowInsights(repositoryId: string, events: ProjectMemoryEvent[]): Insight[] {
    const insights: Insight[] = [];
    for (const event of events) {
      if (event.outcome.kind !== "result" || event.outcome.result.kind !== "workflow") {
        continue;
      }
      const workflowResult = event.outcome.result.workflowResult;
      if (workflowResult.status !== "failed") {
        continue;
      }
      insights.push({
        kind: "unfinished-workflow",
        severity: "warning",
        repositoryId,
        notificationWorthy: true,
        workflowId: workflowResult.workflowId,
        correlationId: workflowResult.correlationId,
        failedStepId: workflowResult.failedStep?.stepId,
      });
    }
    return insights;
  }

  // Note: memory events recorded from a thrown error (outcome.kind === "error")
  // carry only the error message, not the originating task type or workflow id
  // (ProjectMemoryEvent doesn't retain the request) — so only "result"-kind
  // failures, which carry taskResult.taskType / workflowResult.workflowId, can
  // be grouped here. This is an honest data limitation, not a missed case.
  private detectRepeatedFailureInsights(repositoryId: string, events: ProjectMemoryEvent[]): Insight[] {
    const taskFailureCounts = new Map<string, number>();
    const workflowFailureCounts = new Map<string, number>();

    for (const event of events) {
      if (event.outcome.kind !== "result") {
        continue;
      }
      const result = event.outcome.result;
      if (result.kind === "task" && !result.taskResult.success) {
        taskFailureCounts.set(result.taskResult.taskType, (taskFailureCounts.get(result.taskResult.taskType) ?? 0) + 1);
      }
      if (result.kind === "workflow" && result.workflowResult.status === "failed") {
        const { workflowId } = result.workflowResult;
        workflowFailureCounts.set(workflowId, (workflowFailureCounts.get(workflowId) ?? 0) + 1);
      }
    }

    const insights: Insight[] = [];
    for (const [taskType, occurrences] of taskFailureCounts) {
      if (occurrences >= REPEATED_FAILURE_THRESHOLD) {
        insights.push({
          kind: "repeated-failures",
          severity: occurrences >= REPEATED_FAILURE_THRESHOLD * 2 ? "critical" : "warning",
          repositoryId,
          notificationWorthy: true,
          taskType,
          occurrences,
        });
      }
    }
    for (const [workflowId, occurrences] of workflowFailureCounts) {
      if (occurrences >= REPEATED_FAILURE_THRESHOLD) {
        insights.push({
          kind: "repeated-failures",
          severity: occurrences >= REPEATED_FAILURE_THRESHOLD * 2 ? "critical" : "warning",
          repositoryId,
          notificationWorthy: true,
          workflowId,
          occurrences,
        });
      }
    }
    return insights;
  }

  private detectApprovalInsights(repositoryId: string, snapshot: RepositorySnapshot): Insight[] {
    const insights: Insight[] = [];
    if (snapshot.workflowReadiness.requiresApprovalBeforePush) {
      insights.push({
        kind: "approval-required",
        severity: "info",
        repositoryId,
        notificationWorthy: false,
        action: "push-changes",
      });
    }
    if (snapshot.workflowReadiness.requiresApprovalBeforePullRequest) {
      insights.push({
        kind: "approval-required",
        severity: "info",
        repositoryId,
        notificationWorthy: false,
        action: "create-pull-request",
      });
    }
    return insights;
  }

  private detectOpenPullRequestsInsight(repositoryId: string, snapshot: RepositorySnapshot): Insight[] {
    if (snapshot.pullRequests.openCount <= 0) {
      return [];
    }
    return [
      {
        kind: "open-pull-requests",
        severity: "info",
        repositoryId,
        notificationWorthy: false,
        count: snapshot.pullRequests.openCount,
      },
    ];
  }

  private detectSessionInsight(repositoryId: string, sessionInfo: ClaudeSessionInfo | undefined): Insight[] {
    if (!sessionInfo || sessionInfo.status !== "expired") {
      return [];
    }
    return [
      {
        kind: "session-expired",
        severity: "info",
        repositoryId,
        notificationWorthy: false,
        sessionId: sessionInfo.id,
        lastUsedAt: sessionInfo.lastUsedAt,
      },
    ];
  }

  private detectRiskySituation(repositoryId: string, insights: Insight[]): Insight[] {
    const warningsOrAbove = insights.filter((insight) => insight.severity === "warning" || insight.severity === "critical");
    if (warningsOrAbove.length < RISKY_SITUATION_MIN_WARNINGS) {
      return [];
    }
    return [
      {
        kind: "risky-situation",
        severity: "critical",
        repositoryId,
        notificationWorthy: true,
        contributingKinds: warningsOrAbove.map((insight) => insight.kind),
      },
    ];
  }
}
