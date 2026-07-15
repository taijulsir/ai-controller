import type { IContextBuilder } from "../context/interfaces";
import type { ExecutionContext } from "../context/types";
import type { IDecisionEngine } from "../decisions/interfaces";
import type { Insight } from "../decisions/types";
import type { RepositorySnapshot } from "../intelligence/types";
import type { Task } from "../planner/types";
import type { IClaudeSessionManager } from "../session/interfaces";
import type { IExecutionStrategyEngine } from "./interfaces";
import type {
  ApprovalExpectation,
  ContextPolicy,
  ExecutionPriority,
  ExecutionReadiness,
  RecommendedAction,
  SafetyRecommendation,
  SessionPolicy,
  StrategyRequest,
  TaskExecutionStrategy,
} from "./types";

// Pure decision-support engine: it only reads through the three interfaces
// below and never executes a workflow, calls Claude, touches git/GitHub, or
// contains any transport (Telegram) logic. The RepositorySnapshot it reasons
// about arrives as part of the request — it never fetches one itself, so it
// always sees exactly the snapshot its caller (ExecutionPipeline, as part of
// the shared PipelineContext) already resolved. Its output — a
// TaskExecutionStrategy — is advisory. In particular, `approvalExpectation`
// is a *report* of what ApprovalPolicy would decide, not a gate: ApprovalEngine
// remains the sole authority over whether an action actually requires
// approval.
export class StrategyEngine implements IExecutionStrategyEngine {
  constructor(
    private readonly decisionEngine: IDecisionEngine,
    private readonly contextBuilder: IContextBuilder,
    private readonly sessionManager: IClaudeSessionManager,
  ) {}

  async recommend(request: StrategyRequest): Promise<TaskExecutionStrategy> {
    const snapshot = request.repository;
    const repositoryId = snapshot.repository.id;

    const [insightReport, context] = await Promise.all([
      this.decisionEngine.analyze(snapshot),
      this.contextBuilder.build({ repository: snapshot, task: request.task }),
    ]);

    const sessionPolicy = this.buildSessionPolicy(repositoryId);
    const contextPolicy = this.buildContextPolicy(context);
    const approvalExpectation = this.buildApprovalExpectation(request.task, snapshot);
    const executionReadiness = this.buildExecutionReadiness(request.task, snapshot, insightReport.insights);
    const executionPriority = this.buildExecutionPriority(executionReadiness, insightReport.insights);
    const safetyRecommendations = this.buildSafetyRecommendations(insightReport.insights);
    const recommendedAction = this.resolveRecommendedAction(
      request.task,
      snapshot,
      sessionPolicy,
      approvalExpectation,
      executionReadiness,
    );

    return {
      repositoryId,
      taskType: request.task.type,
      sessionPolicy,
      contextPolicy,
      executionPriority,
      approvalExpectation,
      recommendedAction,
      executionReadiness,
      safetyRecommendations,
      generatedAt: new Date(),
    };
  }

  // Reads session state via the read-only getSessionStatus() rather than
  // resolveSession() on purpose: resolveSession() creates/touches a session
  // record as a side effect, which an advisory-only engine must never do —
  // asking for a strategy must not itself change what "continue" means for
  // the real execution that (maybe) follows.
  private buildSessionPolicy(repositoryId: string): SessionPolicy {
    const info = this.sessionManager.getSessionStatus(repositoryId);
    if (info && info.status === "active") {
      return { action: "continue", sessionId: info.id };
    }
    return {
      action: "start-new",
      reason: info?.status === "expired" ? "session-expired" : "no-active-session",
    };
  }

  private buildContextPolicy(context: ExecutionContext): ContextPolicy {
    return {
      includeRelevantHistory: context.relevantHistory.length > 0,
      relevantHistoryCount: context.relevantHistory.length,
      warnings: context.warnings,
    };
  }

  // Reuses RepositorySnapshot.workflowReadiness (already computed by
  // RepositoryIntelligenceService via the shared ApprovalPolicy) instead of
  // depending on ApprovalPolicy/ConfigService directly — approval policy
  // stays singly-owned, this engine only reports what it implies for the
  // specific requested task.
  private buildApprovalExpectation(task: Task, snapshot: RepositorySnapshot): ApprovalExpectation {
    if (task.type === "push-changes" && snapshot.workflowReadiness.requiresApprovalBeforePush) {
      return { expected: true, reason: "push-changes requires approval under the current approval policy" };
    }
    if (task.type === "create-pull-request" && snapshot.workflowReadiness.requiresApprovalBeforePullRequest) {
      return { expected: true, reason: "create-pull-request requires approval under the current approval policy" };
    }
    return { expected: false };
  }

  private buildExecutionReadiness(task: Task, snapshot: RepositorySnapshot, insights: Insight[]): ExecutionReadiness {
    const blockers: string[] = [];

    if (!snapshot.health.isGitRepository) {
      blockers.push("Repository path is not a valid git repository.");
    }

    if (task.type === "push-changes" || task.type === "create-pull-request") {
      blockers.push(...snapshot.workflowReadiness.blockers);
    }

    for (const insight of insights) {
      if (insight.severity === "critical") {
        blockers.push(this.describeInsight(insight));
      }
    }

    return { ready: blockers.length === 0, blockers };
  }

  private buildExecutionPriority(readiness: ExecutionReadiness, insights: Insight[]): ExecutionPriority {
    if (!readiness.ready) {
      return "blocked";
    }
    const hasWarningOrAbove = insights.some(
      (insight) => insight.severity === "warning" || insight.severity === "critical",
    );
    return hasWarningOrAbove ? "elevated" : "normal";
  }

  private buildSafetyRecommendations(insights: Insight[]): SafetyRecommendation[] {
    return insights
      .filter((insight) => insight.severity !== "info")
      .map((insight) => ({
        severity: insight.severity,
        message: this.describeInsight(insight),
        insightKind: insight.kind,
      }));
  }

  private describeInsight(insight: Insight): string {
    switch (insight.kind) {
      case "unclean-working-tree":
        return `Working tree is unclean: ${insight.staged} staged, ${insight.unstaged} unstaged, ${insight.untracked} untracked.`;
      case "unpushed-commits":
        return `${insight.ahead} unpushed commit(s).`;
      case "stale-branch":
        return `Branch "${insight.branch}" is stale (${insight.behind} behind).`;
      case "unfinished-workflow":
        return `Workflow "${insight.workflowId}" did not finish${insight.failedStepId ? ` (failed at step "${insight.failedStepId}")` : ""}.`;
      case "repeated-failures":
        return `Repeated failures detected for ${insight.taskType ?? insight.workflowId} (${insight.occurrences}x).`;
      case "approval-required":
        return `Approval required before ${insight.action}.`;
      case "open-pull-requests":
        return `${insight.count} open pull request(s).`;
      case "session-expired":
        return `Claude session expired (last used ${insight.lastUsedAt.toISOString()}).`;
      case "risky-situation":
        return `Risky situation: contributing factors — ${insight.contributingKinds.join(", ")}.`;
    }
  }

  // Priority order: an unready repository or an active critical insight
  // always wins (ReviewRepository), then a pending approval requirement
  // (WaitForApproval) — both override whatever the requested task literally
  // is, since neither can proceed as asked right now. Below that, the
  // recommendation reflects the engineering intention the requested task
  // most naturally serves.
  private resolveRecommendedAction(
    task: Task,
    snapshot: RepositorySnapshot,
    sessionPolicy: SessionPolicy,
    approvalExpectation: ApprovalExpectation,
    executionReadiness: ExecutionReadiness,
  ): RecommendedAction {
    if (!executionReadiness.ready) {
      return "ReviewRepository";
    }
    if (approvalExpectation.expected) {
      return "WaitForApproval";
    }

    switch (task.type) {
      case "create-commit":
      case "push-changes":
      case "create-pull-request":
        return "ShipChanges";
      case "analyze-repository":
      case "explain-code":
      case "list-pull-requests":
      case "verify-git-status":
        return "AnalyzeFirst";
      case "implement-feature":
      case "fix-bug":
        if (sessionPolicy.action === "continue") {
          return "ContinueCurrentTask";
        }
        return snapshot.branch.current === snapshot.branch.default ? "CreateFeatureBranch" : "ContinueCurrentTask";
    }
  }
}
