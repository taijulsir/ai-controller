import type { ExecutionResult, OrchestrationResult } from "../controller/types";
import type { Insight, RepositoryInsightReport } from "../decisions/types";
import type { RepositorySnapshot } from "../intelligence/types";
import type { ProjectMemoryEvent } from "../memory/types";
import type { PipelineResult, PipelineStepOutcome } from "../pipeline/types";
import type { RuntimeReport, RuntimeReportSection } from "../reporting/types";
import type { ClaudeSessionInfo } from "../session/types";
import type { IResponseFormatter } from "./interfaces";

// Section titles as produced by RuntimeReportingEngine (Phase 8.9) — used
// only to select which already-built sections to include per runtime query
// view, never to reformat or reinterpret their content.
const RUNTIME_STATUS_SECTION_TITLES = ["Runtime", "Workers", "Monitoring", "Policy", "Attention"];

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

  formatPipelineResult(result: PipelineResult): string {
    // Bypass results carry a plain ExecutionResult from a standalone
    // create-commit/push-changes/create-pull-request command — reusing
    // format() here guarantees identical output to what that command
    // produced before ExecutionPipeline existed.
    if (result.path === "bypass") {
      return this.format(result.result);
    }

    const lines = [`Recommended action: ${result.strategy.recommendedAction}`];
    for (const outcome of result.stepOutcomes) {
      lines.push(this.formatPipelineStepOutcome(outcome));
    }

    const lastOutcome = result.stepOutcomes[result.stepOutcomes.length - 1];
    if (lastOutcome?.status === "executed") {
      lines.push("", this.format(lastOutcome.result));
    }

    return lines.join("\n");
  }

  private formatPipelineStepOutcome(outcome: PipelineStepOutcome): string {
    switch (outcome.status) {
      case "executed": {
        const succeeded = outcome.result.kind === "task" ? outcome.result.taskResult.success : outcome.result.workflowResult.status === "completed";
        return `${succeeded ? "✓" : "✗"} ${outcome.capability}`;
      }
      case "blocked":
        return `⛔ ${outcome.capability}: ${outcome.explanation}\nNext step: ${outcome.recommendedAction}`;
      case "skipped":
        return `— ${outcome.capability} skipped: ${outcome.reason}`;
    }
  }

  // Phase 8.10: the full report — title, health, summary, then every
  // section in the order RuntimeReportingEngine produced them. Every piece
  // of text here (report.title, report.health, report.summary,
  // section.title, section.lines) is used verbatim; only the ordering and
  // blank-line separation between sections is decided here.
  formatRuntimeReport(report: RuntimeReport): string {
    const lines: string[] = [report.title, report.health, report.summary];
    for (const section of report.sections) {
      lines.push("", section.title, ...section.lines);
    }
    return lines.join("\n");
  }

  // The "raw facts" view: every section except Findings — i.e. everything
  // RuntimeStatus itself would have shown, with no health verdict attached.
  formatRuntimeStatus(report: RuntimeReport): string {
    return this.joinSections(this.selectSections(report, RUNTIME_STATUS_SECTION_TITLES));
  }

  // The "judgment" view: health + summary + the Findings section only —
  // deliberately excludes the raw-facts sections, mirroring the same
  // status-vs-diagnosis split RuntimeStatus/RuntimeDiagnosticsReport
  // themselves already draw.
  formatRuntimeDiagnostics(report: RuntimeReport): string {
    const lines: string[] = [report.health, report.summary];
    for (const section of this.selectSections(report, ["Findings"])) {
      lines.push("", section.title, ...section.lines);
    }
    return lines.join("\n");
  }

  formatRuntimeMonitoring(report: RuntimeReport): string {
    return this.joinSections(this.selectSections(report, ["Monitoring"]));
  }

  formatRuntimePolicy(report: RuntimeReport): string {
    return this.joinSections(this.selectSections(report, ["Policy"]));
  }

  // The one shared section-selection helper (Phase 8.10) — returns the
  // named sections in RuntimeReport.sections' own order, never reordering,
  // filtering finding content, or inspecting section.lines. Every narrower
  // runtime view above is built from this one helper rather than repeating
  // its own filter logic.
  private selectSections(report: RuntimeReport, titles: string[]): RuntimeReportSection[] {
    return report.sections.filter((section) => titles.includes(section.title));
  }

  private joinSections(sections: RuntimeReportSection[]): string {
    const lines: string[] = [];
    for (const section of sections) {
      if (lines.length > 0) {
        lines.push("");
      }
      lines.push(section.title, ...section.lines);
    }
    return lines.join("\n");
  }
}
