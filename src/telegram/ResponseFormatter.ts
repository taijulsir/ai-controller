import type { ExecutionResult, OrchestrationResult } from "../controller/types";
import type { Insight, RepositoryInsightReport } from "../decisions/types";
import type { RepositorySnapshot } from "../intelligence/types";
import type { ProjectMemoryEvent } from "../memory/types";
import type { ClaudeSessionInfo } from "../session/types";
import type { IResponseFormatter } from "./interfaces";

export class ResponseFormatter implements IResponseFormatter {
  format(result: ExecutionResult): string {
    if (result.kind === "workflow") {
      return this.formatWorkflowResult(result.workflowResult);
    }

    const { taskResult } = result;
    if (!taskResult.success) {
      return `Task "${taskResult.taskType}" failed: ${taskResult.error ?? "unknown error"}`;
    }

    return taskResult.output
      ? `Task "${taskResult.taskType}" completed successfully.\n\n${taskResult.output}`
      : `Task "${taskResult.taskType}" completed successfully.`;
  }

  private formatWorkflowResult(workflowResult: OrchestrationResult): string {
    const stepLines = workflowResult.steps.map((step) => {
      const succeeded = step.executionResult.kind === "task" && step.executionResult.taskResult.success;
      return `${succeeded ? "✓" : "✗"} ${step.stepId} (${step.taskType})`;
    });

    if (workflowResult.status === "failed" && workflowResult.failedStep) {
      const failedExecution = workflowResult.failedStep.executionResult;
      const reason = failedExecution.kind === "task" ? failedExecution.taskResult.error ?? "unknown error" : "unknown error";
      return (
        `Workflow "${workflowResult.workflowId}" failed at step "${workflowResult.failedStep.stepId}": ${reason}\n\n` +
        stepLines.join("\n")
      );
    }

    return `Workflow "${workflowResult.workflowId}" completed successfully.\n\n${stepLines.join("\n")}`;
  }

  formatRepositoryStatus(snapshot: RepositorySnapshot): string {
    const { repository, branch, workingTree, pullRequests, workflowReadiness } = snapshot;
    const treeLine = workingTree.isClean
      ? "clean"
      : `${workingTree.staged.length} staged, ${workingTree.unstaged.length} unstaged, ${workingTree.untracked.length} untracked`;

    return [
      `Repository: ${repository.name} (${repository.id})`,
      `Branch: ${branch.current} (default: ${branch.default}) — ${branch.ahead} ahead, ${branch.behind} behind`,
      `Working tree: ${treeLine}`,
      `Open pull requests: ${pullRequests.openCount}`,
      `Can ship: ${workflowReadiness.canShip ? "yes" : `no (${workflowReadiness.blockers.join("; ")})`}`,
    ].join("\n");
  }

  formatHistory(events: ProjectMemoryEvent[]): string {
    if (events.length === 0) {
      return "No recorded history for this repository.";
    }

    return events.map((event) => this.formatHistoryEvent(event)).join("\n");
  }

  private formatHistoryEvent(event: ProjectMemoryEvent): string {
    const timestamp = event.recordedAt.toISOString();

    if (event.outcome.kind === "error") {
      return `✗ error: ${event.outcome.error} (${timestamp})`;
    }

    const { result } = event.outcome;
    if (result.kind === "task") {
      const succeeded = result.taskResult.success;
      return `${succeeded ? "✓" : "✗"} ${result.taskResult.taskType} (${timestamp})`;
    }

    const succeeded = result.workflowResult.status === "completed";
    const stepSuffix = !succeeded && result.workflowResult.failedStep ? ` at step "${result.workflowResult.failedStep.stepId}"` : "";
    return `${succeeded ? "✓" : "✗"} workflow "${result.workflowResult.workflowId}"${stepSuffix} (${timestamp})`;
  }

  formatInsights(report: RepositoryInsightReport): string {
    if (report.insights.length === 0) {
      return "No issues detected.";
    }

    return report.insights.map((insight) => this.formatInsight(insight)).join("\n");
  }

  private formatInsight(insight: Insight): string {
    const icon = insight.severity === "critical" ? "🔴" : insight.severity === "warning" ? "⚠" : "ℹ";

    switch (insight.kind) {
      case "unclean-working-tree":
        return `${icon} Unclean working tree: ${insight.staged} staged, ${insight.unstaged} unstaged, ${insight.untracked} untracked`;
      case "unpushed-commits":
        return `${icon} ${insight.ahead} unpushed commit(s)`;
      case "stale-branch":
        return `${icon} Branch "${insight.branch}" is stale: ${insight.behind} behind`;
      case "unfinished-workflow":
        return `${icon} Unfinished workflow "${insight.workflowId}"${insight.failedStepId ? ` at step "${insight.failedStepId}"` : ""}`;
      case "repeated-failures":
        return `${icon} Repeated failures: ${insight.taskType ?? insight.workflowId} x${insight.occurrences}`;
      case "approval-required":
        return `${icon} Approval required before ${insight.action}`;
      case "open-pull-requests":
        return `${icon} ${insight.count} open pull request(s)`;
      case "session-expired":
        return `${icon} Session expired (last used ${insight.lastUsedAt.toISOString()})`;
      case "risky-situation":
        return `${icon} Risky situation: ${insight.contributingKinds.join(", ")}`;
    }
  }

  formatSessionStatus(info: ClaudeSessionInfo | undefined): string {
    if (!info) {
      return "No session for this repository.";
    }
    return `Session ${info.id} — ${info.status}, created ${info.createdAt.toISOString()}, last used ${info.lastUsedAt.toISOString()}`;
  }
}
