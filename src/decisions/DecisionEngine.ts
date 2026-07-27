import type { RepositorySnapshot } from "../intelligence/types";
import type { IProjectMemoryService } from "../memory/interfaces";
import { FAILURE_BLOCK_THRESHOLD } from "../memory/ProjectMemoryService";
import type { ProjectMemoryEvent, TaskFailureState } from "../memory/types";
import type { IClaudeSessionManager } from "../session/interfaces";
import type { ClaudeSessionInfo } from "../session/types";
import type { IDecisionEngine } from "./interfaces";
import type { Insight, RepositoryInsightReport } from "./types";

// Kept internal for now; promote to config/controller.yaml if a future
// frontend needs these tunable, same precedent as prior phases' constants.
const STALE_BRANCH_BEHIND_THRESHOLD = 5;
const STALE_COMMIT_AGE_DAYS = 14;
// Repository Failure Policy redesign: this threshold is now workflow-path
// only (see detectRepeatedFailureInsights below) -- the task-type path uses
// CONSECUTIVE_FAILURE_WARNING_THRESHOLD/FAILURE_BLOCK_THRESHOLD instead,
// sourced from consecutive counts persisted by ProjectMemoryService, not a
// cumulative scan over recent events.
const REPEATED_FAILURE_THRESHOLD = 2;
const RISKY_SITUATION_MIN_WARNINGS = 2;

// Repository Failure Policy redesign: task-type-scoped repeated-failure
// severity now comes from ProjectMemoryService's persisted, consecutive
// per-(repositoryId, taskType) counter (IFailureStateStore) instead of a
// cumulative scan over the last 20 events. Warning at 2 consecutive
// failures, critical (and, via StrategyEngine, blocking) at
// FAILURE_BLOCK_THRESHOLD (5) -- imported from ProjectMemoryService rather
// than redeclared here, since that's the one place "blocked" is actually
// derived and persisted; this engine must never disagree with it about where
// the line is. Exported so ApplicationService.getFailureStatus can label
// /failures' output ("blocked"/"warning"/"healthy") from this exact same
// number rather than a second, independently-maintained copy of it.
export const CONSECUTIVE_FAILURE_WARNING_THRESHOLD = 2;

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
    const [recentHistory, failureStates] = await Promise.all([
      this.projectMemory.getRecentEvents({ repositoryId }),
      this.projectMemory.getAllFailureStates(repositoryId),
    ]);
    const sessionInfo = this.sessionManager.getSessionStatus(repositoryId);

    const insights: Insight[] = [
      ...this.detectWorkingTreeInsights(repositoryId, snapshot),
      ...this.detectUnpushedCommitsInsight(repositoryId, snapshot),
      ...this.detectStaleBranchInsight(repositoryId, snapshot),
      ...this.detectUnfinishedWorkflowInsights(repositoryId, recentHistory),
      ...this.detectRepeatedFailureInsights(repositoryId, recentHistory, failureStates),
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

  // Repository Failure Policy redesign: two independent halves, kept
  // deliberately separate.
  //
  // Task-type half: sourced from ProjectMemoryService's persisted,
  // consecutive per-(repositoryId, taskType) counter (failureStates), not a
  // scan over `events` -- a single success already reset the count to 0
  // there (ProjectMemoryService.recordTaskOutcome), so this never
  // re-derives a cumulative total the way the old code did. `occurrences`
  // on the resulting Insight means "current consecutive count" for this
  // half specifically (see its own field doc comment in ./types.ts).
  //
  // Workflow half: unchanged from before this redesign -- still a cumulative
  // scan over recent `events`, still gated by REPEATED_FAILURE_THRESHOLD.
  // Workflows have no single task-type identity to key a consecutive counter
  // off (a workflow is a sequence of steps, each its own task type), and the
  // redesign's persisted schema is (repositoryId, taskType) only -- so this
  // half deliberately keeps the old "honest data limitation" noted below.
  // Once StrategyEngine requires insight.taskType === task.type to block
  // (see StrategyEngine.buildExecutionReadiness), a workflow-keyed insight
  // (taskType always undefined here) can never satisfy that condition, so it
  // automatically stays informational-only -- no special case needed to
  // achieve that.
  //
  // Note: memory events recorded from a thrown error (outcome.kind === "error")
  // carry only the error message, not the originating task type or workflow id
  // (ProjectMemoryEvent doesn't retain the request) — so only "result"-kind
  // failures, which carry workflowResult.workflowId, can be grouped here for
  // the workflow half. This is an honest data limitation, not a missed case.
  // (The task-type half no longer has this limitation at all -- see
  // ProjectMemoryService.updateFailureStateFromOutcome's own doc comment for
  // why thrown errors now count as failures there.)
  private detectRepeatedFailureInsights(
    repositoryId: string,
    events: ProjectMemoryEvent[],
    failureStates: TaskFailureState[],
  ): Insight[] {
    const workflowFailureCounts = new Map<string, number>();

    for (const event of events) {
      if (event.outcome.kind !== "result") {
        continue;
      }
      const result = event.outcome.result;
      if (result.kind === "workflow" && result.workflowResult.status === "failed") {
        const { workflowId } = result.workflowResult;
        workflowFailureCounts.set(workflowId, (workflowFailureCounts.get(workflowId) ?? 0) + 1);
      }
    }

    const insights: Insight[] = [];
    for (const state of failureStates) {
      if (state.consecutiveFailures >= CONSECUTIVE_FAILURE_WARNING_THRESHOLD) {
        insights.push({
          kind: "repeated-failures",
          severity: state.consecutiveFailures >= FAILURE_BLOCK_THRESHOLD ? "critical" : "warning",
          repositoryId,
          notificationWorthy: true,
          taskType: state.taskType,
          occurrences: state.consecutiveFailures,
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
