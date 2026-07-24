import type { ArtifactList, ArtifactMetadata } from "../artifacts";
import type { ExecutionResult, OrchestrationResult } from "../controller/types";
import type { Insight, RepositoryInsightReport } from "../decisions/types";
import type { CurrentTaskReport, TaskCancellationOutcome } from "../executionstate/types";
import type { UndoOutcome } from "../undo/types";
import type { RepositorySnapshot } from "../intelligence/types";
import type { ProjectMemoryEvent } from "../memory/types";
import type { PipelineResult, PipelineStepOutcome } from "../pipeline/types";
import { TASK_CANCELLED_MESSAGE } from "../planner/errors";
import type { Recommendation, RepositoryRecommendationReport } from "../recommendations/types";
import type { RuntimeReport, RuntimeReportSection } from "../reporting/types";
import type { SessionLifecycleState, SessionReport, SessionStopOutcome } from "../session/types";
import type { Capability } from "../coordination/types";
import type { RecommendedAction } from "../strategy/types";
import type { IResponseFormatter } from "./interfaces";
import { escapeHtml } from "./TelegramHtml";

// Section titles as produced by RuntimeReportingEngine (Phase 8.9) — used
// only to select which already-built sections to include per runtime query
// view, never to reformat or reinterpret their content.
const RUNTIME_STATUS_SECTION_TITLES = ["Runtime", "Workers", "Monitoring", "Policy", "Attention"];

// Purely a display mapping -- StrategyEngine's own recommendedAction value is
// completely unchanged, this only decides how it reads to a human. Adding a
// new RecommendedAction elsewhere would fail to compile here until a label is
// added, so this can never silently fall out of sync.
const RECOMMENDED_ACTION_LABELS: Record<RecommendedAction, string> = {
  AnalyzeFirst: "Analyzing the repository first",
  ContinueCurrentTask: "Continuing the current work",
  CreateFeatureBranch: "Creating a feature branch first",
  ShipChanges: "Shipping the changes",
  ReviewRepository: "Repository needs review",
  WaitForApproval: "Waiting for approval",
};

// Same reasoning as RECOMMENDED_ACTION_LABELS above, for ExecutionCoordinator's
// Capability value.
const CAPABILITY_LABELS: Record<Capability, string> = {
  VerifyRepository: "Verify repository",
  PublishRepository: "Publish repository",
  RequestIntegration: "Open pull request",
  ContinueImplementation: "Continue implementation",
  HumanReview: "Human review",
  BranchManagement: "Branch management",
  IntegratedDelivery: "Ship changes",
};

// Purely a display mapping over SessionLifecycleState, computed entirely
// upstream by deriveSessionLifecycleState() from metadata this class never
// owns -- no new state, just an icon per already-derived value.
const SESSION_LIFECYCLE_LABELS: Record<SessionLifecycleState, string> = {
  active: "🟢 Active",
  idle: "🟡 Idle",
  expired: "⚪ Expired",
  none: "🔴 No Session",
};

// Static /help text — one line per currently implemented command, grouped
// the same way CommandParser itself groups them (query commands, task
// commands, bypass-eligible git commands, the one workflow). Kept in sync
// with CommandParser.commandHandlers/QUERY_COMMANDS by hand: this list
// exists precisely because there is no runtime command registry to
// introspect instead.
const HELP_TEXT_LINES: readonly string[] = [
  "/status",
  "/history [limit]",
  "/insights",
  "/session",
  "/session reset",
  "/session stop",
  "/recommendations",
  "/task",
  "/task cancel",
  "/undo",
  "/runtime [report|status|diagnostics|monitoring|policy]",
  "/artifact",
  "/artifact get &lt;id&gt;",
  "/artifact search &lt;query&gt;",
  "",
  "AI",
  "/analyze [focus]",
  "/explain &lt;target&gt;",
  "/implement &lt;description&gt;",
  "/fix &lt;description&gt;",
  "/review [focus]",
  "",
  "Git",
  "/branch",
  "/branch &lt;name&gt;",
  "/branch create &lt;name&gt;",
  "/branches",
  "/commit &lt;message&gt;",
  "/push",
  "/create-pr &lt;title&gt;",
  "/list-prs",
  "/fetch",
  "/sync",
  "/merge &lt;branch&gt;",
  "",
  "Workflow",
  "/ship &lt;message&gt;",
  "/auto-execute",
  "",
  "Repository override:",
  "repo=&lt;repository-id&gt; may appear before or after the command.",
  "",
  "Examples:",
  "repo=test-ai-controller /status",
  "/status repo=test-ai-controller",
];

export class ResponseFormatter implements IResponseFormatter {
  format(result: ExecutionResult): string {
    if (result.kind === "workflow") {
      return this.formatWorkflowResult(result.workflowResult);
    }

    const { taskResult } = result;
    if (!taskResult.success) {
      // Distinct from a genuine failure (item 6): a cancelled task is an
      // intentional outcome the user asked for via /task cancel, not
      // something that went wrong -- rendering it with the same "Failed"
      // wording as a real error would read as a contradiction right after
      // /task cancel's own "🛑 Cancelled." confirmation.
      if (taskResult.error === TASK_CANCELLED_MESSAGE) {
        return this.template("🛑", "Task Cancelled", [this.field("Task", this.code(taskResult.taskType))]);
      }
      return this.template("❌", "Task Failed", [
        this.field("Task", this.code(taskResult.taskType)),
        this.field("Reason", this.escapeHtml(taskResult.error ?? "unknown error")),
      ]);
    }

    // switch-branch/create-branch always take the bypass path (see
    // ExecutionPipeline's BYPASS_TASK_TYPES), so this is the one place their
    // result is ever formatted — taskResult.output is just the branch name
    // (SwitchBranchWorkflow/CreateBranchWorkflow set nothing else), never
    // pre-formatted text.
    if (taskResult.taskType === "switch-branch") {
      return this.template("✅", "Branch Switched", [this.field("Branch", this.code(taskResult.output ?? ""))]);
    }
    if (taskResult.taskType === "create-branch") {
      return this.template("✅", "Branch Created", [this.field("Branch", this.code(taskResult.output ?? ""))]);
    }

    // fetch/sync/merge already produce a fully-formed, human-readable
    // sentence in taskResult.output (unlike switch-branch/create-branch's
    // bare branch name above) -- this only adds an icon/title distinct from
    // the generic "Task Completed" case, the same reasoning "🔍 Code Review"
    // already applies to review-code's own output elsewhere in this file.
    if (taskResult.taskType === "fetch") {
      return this.template("📡", "Fetched", taskResult.output ? [this.escapeHtml(taskResult.output)] : []);
    }
    if (taskResult.taskType === "sync") {
      return this.template("🔄", "Synced", taskResult.output ? [this.escapeHtml(taskResult.output)] : []);
    }
    if (taskResult.taskType === "merge") {
      return this.template("🔀", "Merged", taskResult.output ? [this.escapeHtml(taskResult.output)] : []);
    }

    const lines = [this.field("Task", this.code(taskResult.taskType))];
    if (taskResult.output) {
      lines.push("", this.escapeHtml(taskResult.output));
    }
    lines.push(...this.artifactsFooterLines(taskResult.artifacts));
    return this.template("✅", "Task Completed", lines);
  }

  private formatWorkflowResult(workflowResult: OrchestrationResult): string {
    const stepLines = workflowResult.steps.map((step) => {
      const succeeded = step.executionResult.kind === "task" && step.executionResult.taskResult.success;
      return `${succeeded ? "✓" : "✗"} ${this.escapeHtml(step.stepId)} (${this.code(step.taskType)})`;
    });

    if (workflowResult.status === "failed" && workflowResult.failedStep) {
      const failedExecution = workflowResult.failedStep.executionResult;
      const rawReason = failedExecution.kind === "task" ? failedExecution.taskResult.error : undefined;
      const cancelled = rawReason === TASK_CANCELLED_MESSAGE;
      const lines = [
        this.field("Workflow", this.code(workflowResult.workflowId)),
        this.field("Failed At", this.code(workflowResult.failedStep.stepId)),
        this.field("Reason", cancelled ? "Cancelled" : this.escapeHtml(rawReason ?? "unknown error")),
        "",
        ...stepLines,
      ];
      return this.template(cancelled ? "🛑" : "❌", cancelled ? "Workflow Cancelled" : "Workflow Failed", lines);
    }

    return this.template("✅", "Workflow Completed", [this.field("Workflow", this.code(workflowResult.workflowId)), "", ...stepLines]);
  }

  formatRepositoryStatus(snapshot: RepositorySnapshot): string {
    const { repository, branch, workingTree, pullRequests, workflowReadiness } = snapshot;

    return this.template("📊", "Repository Status", [
      this.field("Repository", `${this.code(repository.name)} (${this.code(repository.id)})`),
      this.field("Branch", `${this.code(branch.current)} (default: ${this.code(branch.default)}) — ${branch.ahead} ahead, ${branch.behind} behind`),
      this.field("Working Tree", this.describeWorkingTree(workingTree)),
      this.field("Open Pull Requests", String(pullRequests.openCount)),
      this.field("Can Ship", workflowReadiness.canShip ? "Yes" : `No (${this.escapeHtml(workflowReadiness.blockers.join("; "))})`),
    ]);
  }

  // Same RepositorySnapshot getRepositoryStatus() already returns for
  // /status — a narrower, branch-focused view over it.
  formatBranch(snapshot: RepositorySnapshot): string {
    const { repository, branch, workingTree } = snapshot;

    return this.template("🌿", "Branch", [
      this.field("Repository", this.code(repository.name)),
      this.field("Current", this.code(branch.current)),
      this.field("Default", this.code(branch.default)),
      this.field("Ahead", String(branch.ahead)),
      this.field("Behind", String(branch.behind)),
      this.field("Working Tree", this.describeWorkingTree(workingTree)),
    ]);
  }

  // Same RepositorySnapshot again — sorting/highlighting is purely a
  // display decision, so it lives here rather than in the snapshot itself
  // (GitAdapter.listBranches() returns branches in whatever order git
  // reports them).
  formatBranches(snapshot: RepositorySnapshot): string {
    const { repository, branch, branches } = snapshot;
    const sorted = [...branches].sort((a, b) => a.localeCompare(b));
    const others = sorted.filter((name) => name !== branch.current);

    const lines = [this.field("Repository", this.code(repository.name)), this.field("Current", `⭐ ${this.code(branch.current)}`)];

    if (others.length > 0) {
      lines.push("", "Local Branches:", ...this.truncateBulletList(others.map((name) => this.code(name))));
    } else {
      lines.push("", "No additional branches.");
    }

    return this.template("🌿", "Branches", lines);
  }

  // report is exactly ApplicationService.getCurrentTask()'s own composed
  // view -- status and repositoryName already decided (approval-pending
  // cross-check, repository name lookup), never re-derived here. This only
  // lays the fields out in the requested order; "Idle" is the one case with
  // no snapshot to lay out at all.
  formatCurrentTask(report: CurrentTaskReport | undefined): string {
    if (!report) {
      return "✅ No task is currently running.";
    }

    const { status, repositoryName, snapshot } = report;
    const isWaitingApproval = status === "waiting-approval";
    const lines = [
      this.field("Repository", this.code(repositoryName)),
      this.field("Status", isWaitingApproval ? "Waiting Approval" : "Running"),
      this.field("Task", this.code(snapshot.task || "-")),
      this.field("Workflow", this.code(snapshot.workflow || "-")),
    ];

    if (snapshot.currentStep) {
      lines.push(this.field("Current Step", this.code(snapshot.currentStep)));
    }
    if (snapshot.progress) {
      lines.push(this.field("Progress", `${snapshot.progress.completed}/${snapshot.progress.total}`));
    }

    lines.push(
      this.field("Started", this.formatTimestamp(snapshot.startedAt)),
      this.field("Running For", this.formatDuration(Date.now() - snapshot.startedAt.getTime())),
      this.field("Approval", isWaitingApproval ? "Waiting" : "Not Waiting"),
      this.field("Correlation ID", this.code(snapshot.correlationId)),
      this.field("Executor", this.escapeHtml(snapshot.executor)),
    );

    return this.template("📋", "Current Task", lines);
  }

  // outcome.kind is already the fully-decided branch ApplicationService
  // produced (execution state + approval state + cancellation policy,
  // composed there, never here) -- this only lays each one out as text.
  // "nothing-running" and "already-finished" intentionally read as the same
  // "nothing to cancel" message: ApplicationService itself cannot tell them
  // apart by the time cancelCurrentTask() runs (no stale record is ever kept
  // around to distinguish "never existed" from "just finished"), so this
  // does not pretend to make a distinction that isn't actually known.
  formatCancelResult(outcome: TaskCancellationOutcome): string {
    switch (outcome.kind) {
      case "nothing-running":
      case "already-finished":
        return "✅ Nothing to cancel — no task is currently running for this repository.";
      case "cancelled":
        return this.template("🛑", "Cancelled", [
          this.field("Task", this.code(outcome.snapshot.currentStep || outcome.snapshot.task || outcome.snapshot.workflow)),
          this.field("Correlation ID", this.code(outcome.snapshot.correlationId)),
        ]);
      case "cancelled-approval":
        return this.template("🛑", "Cancelled Pending Approval", [
          this.field("Task", this.code(outcome.snapshot.task || outcome.snapshot.currentStep || "")),
          this.field("Correlation ID", this.code(outcome.snapshot.correlationId)),
        ]);
      case "not-cancellable":
        return this.template("⚠️", "Cannot Cancel", [
          `The current step (${this.code(outcome.snapshot.currentStep || outcome.snapshot.task)}) is a short git/GitHub operation ` +
            "already in progress and will finish on its own in a moment.",
        ]);
      case "already-cancelling":
        return "🛑 Cancellation already requested — the task is stopping now.";
    }
  }

  // outcome is exactly what ApplicationService.undoLastExecution() decided —
  // this only lays each branch out as text. The file list is capped so a
  // large execution's undo confirmation never floods the chat.
  formatUndoResult(outcome: UndoOutcome): string {
    switch (outcome.kind) {
      case "nothing-to-undo":
        return "✅ Nothing to undo — no undoable execution found for this repository.";
      case "execution-in-progress":
        return this.template("⚠️", "Cannot Undo", ["A task is currently running for this repository."]);
      case "drift-detected":
        return this.template("⚠️", "Cannot Undo", [
          this.field("Task", this.code(outcome.taskType)),
          this.field("Checkpoint", this.code(this.shortId(outcome.checkpointId))),
          "",
          "These files changed after that execution finished, so undoing would overwrite unrelated changes:",
          ...this.truncateBulletList(outcome.conflictingFiles.map((file) => this.code(file))),
        ]);
      case "undone": {
        const restoredFiles = [...outcome.restoredFiles, ...outcome.deletedFiles];
        return this.template("↩️", "Undo Complete", [
          this.field("Execution ID", this.code(this.shortId(outcome.checkpointId))),
          this.field("Task", this.code(outcome.taskType)),
          "",
          `Restored Files (${restoredFiles.length}):`,
          ...this.truncateBulletList(restoredFiles.map((file) => this.code(file))),
        ]);
      }
    }
  }

  private shortId(id: string): string {
    return id.slice(0, 8);
  }

  private describeWorkingTree(workingTree: RepositorySnapshot["workingTree"]): string {
    return workingTree.isClean
      ? "clean"
      : `${workingTree.staged.length} staged, ${workingTree.unstaged.length} unstaged, ${workingTree.untracked.length} untracked`;
  }

  formatHistory(events: ProjectMemoryEvent[]): string {
    if (events.length === 0) {
      return "No recorded history for this repository.";
    }

    // Deliberately no additional truncation here, unlike the other list
    // views: the caller already controls exactly how many events are
    // returned via /history's own optional limit argument
    // (ApplicationService.getRepositoryHistory -> ProjectMemoryService's own
    // limit, default 20) -- imposing a second, independent display cap on
    // top of a limit the user explicitly asked for would silently override
    // their own request rather than just presenting it.
    return this.template("📜", "History", events.map((event) => this.formatHistoryEvent(event)));
  }

  private formatHistoryEvent(event: ProjectMemoryEvent): string {
    const timestamp = this.formatTimestamp(event.recordedAt);

    if (event.outcome.kind === "error") {
      return `✗ error: ${this.escapeHtml(event.outcome.error)} (${timestamp})`;
    }
    if (event.outcome.kind === "undo") {
      return `↩️ undo (checkpoint ${this.code(this.shortId(event.outcome.undoneCheckpointId))}) (${timestamp})`;
    }

    const { result } = event.outcome;
    if (result.kind === "task") {
      const succeeded = result.taskResult.success;
      return `${succeeded ? "✓" : "✗"} ${this.code(result.taskResult.taskType)} (${timestamp})`;
    }

    const succeeded = result.workflowResult.status === "completed";
    const stepSuffix = !succeeded && result.workflowResult.failedStep ? ` at step ${this.code(result.workflowResult.failedStep.stepId)}` : "";
    return `${succeeded ? "✓" : "✗"} workflow ${this.code(result.workflowResult.workflowId)}${stepSuffix} (${timestamp})`;
  }

  formatInsights(report: RepositoryInsightReport): string {
    if (report.insights.length === 0) {
      return "✅ No issues detected.";
    }

    return this.template("🔎", "Insights", this.truncateBulletList(report.insights.map((insight) => this.formatInsight(insight)), 15, ""));
  }

  private formatInsight(insight: Insight): string {
    const icon = insight.severity === "critical" ? "🔴" : insight.severity === "warning" ? "⚠" : "ℹ";

    switch (insight.kind) {
      case "unclean-working-tree":
        return `${icon} Unclean working tree: ${insight.staged} staged, ${insight.unstaged} unstaged, ${insight.untracked} untracked`;
      case "unpushed-commits":
        return `${icon} ${insight.ahead} unpushed commit(s)`;
      case "stale-branch":
        return `${icon} Branch ${this.code(insight.branch)} is stale: ${insight.behind} behind`;
      case "unfinished-workflow":
        return `${icon} Unfinished workflow ${this.code(insight.workflowId)}${insight.failedStepId ? ` at step ${this.code(insight.failedStepId)}` : ""}`;
      case "repeated-failures":
        return `${icon} Repeated failures: ${this.code(insight.taskType ?? insight.workflowId ?? "unknown")} x${insight.occurrences}`;
      case "approval-required":
        return `${icon} Approval required before ${this.escapeHtml(insight.action)}`;
      case "open-pull-requests":
        return `${icon} ${insight.count} open pull request(s)`;
      case "session-expired":
        return `${icon} Session expired (last used ${this.formatTimestamp(insight.lastUsedAt)})`;
      case "risky-situation":
        return `${icon} Risky situation: ${this.escapeHtml(insight.contributingKinds.join(", "))}`;
    }
  }

  // report is exactly what ApplicationService.getSessionStatus() composed --
  // ClaudeSessionInfo, repository name, currentTask, and the derived
  // lifecycleState are all decided upstream; this only lays them out and
  // picks the lifecycle icon. "Expires In" is shown only while the session
  // is still active (not yet expired) -- computed from info.lastUsedAt and
  // the same idleTimeoutMinutes ClaudeSessionManager itself enforces,
  // exposed via getIdleTimeoutMinutes() rather than a second, hardcoded copy
  // of the same threshold.
  formatSessionStatus(report: SessionReport): string {
    const lines = [
      this.field("Repository", this.code(report.repositoryName)),
      this.field("Lifecycle", SESSION_LIFECYCLE_LABELS[report.lifecycleState]),
    ];

    if (report.info) {
      const idleMs = Date.now() - report.info.lastUsedAt.getTime();
      lines.push(
        this.field("Session ID", this.code(report.info.id)),
        this.field("Created", this.formatTimestamp(report.info.createdAt)),
        this.field("Last Used", this.formatTimestamp(report.info.lastUsedAt)),
        this.field("Idle For", this.formatDuration(idleMs)),
      );
      if (report.info.status === "active") {
        const remainingMs = report.idleTimeoutMinutes * 60_000 - idleMs;
        lines.push(this.field("Expires In", this.formatDuration(Math.max(0, remainingMs))));
      }
    }

    const activeTaskLabel = report.currentTask
      ? this.code(report.currentTask.snapshot.currentStep || report.currentTask.snapshot.task || report.currentTask.snapshot.workflow)
      : "None";
    lines.push(this.field("Active Task", activeTaskLabel));

    return this.template("🧠", "Session", lines);
  }

  // repositoryName is exactly what ApplicationService.resetSession()
  // returned -- resetSession() cannot fail in a user-visible way, so this is
  // always a plain confirmation, never a branch.
  formatSessionResetResult(repositoryName: string): string {
    return this.template("🔄", "Session Reset", [
      this.field("Repository", this.code(repositoryName)),
      "",
      "The next request will start a new conversation.",
    ]);
  }

  // Reuses formatCancelResult() verbatim for the cancellation half (outcome.taskOutcome
  // is exactly a TaskCancellationOutcome, the same one /task cancel already renders) --
  // never a second, independent rendering of the same switch. Only adds the
  // one new fact /session stop contributes on top: whether a session record
  // existed to reset.
  formatSessionStopResult(outcome: SessionStopOutcome): string {
    const taskPart = this.formatCancelResult(outcome.taskOutcome);
    const sessionNote = outcome.sessionWasActive
      ? "The session has also been reset — the next request will start a new conversation."
      : "There was no active session to reset.";
    return `${taskPart}\n\n${sessionNote}`;
  }

  formatHelp(): string {
    return this.template("📖", "AI Controller Commands", ["Repository", ...HELP_TEXT_LINES]);
  }

  // Purely a display transform over the already-computed, already-prioritized
  // RepositoryRecommendationReport (RecommendationEngine, via
  // ApplicationService.getRecommendations() — the same call
  // ProactiveMonitor's push path already uses) — no recommendation is
  // generated, re-derived, or re-prioritized here. "critical" folds into the
  // "High Priority" section (report.recommendations is already sorted
  // critical-first), matching the three sections this command asks for
  // without inventing a fourth.
  formatRecommendations(report: RepositoryRecommendationReport): string {
    if (report.recommendations.length === 0) {
      return "✅ No recommendations at this time.";
    }

    const isHigh = (r: Recommendation) => r.priority === "critical" || r.priority === "high";
    const lines = [this.field("Repository", this.code(report.repositoryId))];

    this.pushRecommendationSection(lines, "High Priority", report.recommendations.filter(isHigh));
    this.pushRecommendationSection(lines, "Medium Priority", report.recommendations.filter((r) => r.priority === "medium"));
    this.pushRecommendationSection(lines, "Low Priority", report.recommendations.filter((r) => r.priority === "low"));

    return this.template("📋", "Recommendations", lines);
  }

  private pushRecommendationSection(lines: string[], title: string, recommendations: Recommendation[]): void {
    if (recommendations.length === 0) {
      return;
    }
    lines.push("", `${title}:`, ...this.truncateBulletList(recommendations.map((r) => this.escapeHtml(r.reason))));
  }

  formatPipelineResult(result: PipelineResult): string {
    // Bypass results carry a plain ExecutionResult from a standalone
    // create-commit/push-changes/create-pull-request command — reusing
    // format() here guarantees identical output to what that command
    // produced before ExecutionPipeline existed.
    if (result.path === "bypass") {
      return this.format(result.result);
    }

    const lastOutcome = result.stepOutcomes[result.stepOutcomes.length - 1];

    // "review-code" is a read-only report, not an engineering action — on
    // the normal AnalyzeFirst/VerifyRepository path (the only path this task
    // type ever takes when the repository is ready), skip the recommended
    // action/step-status preamble every other task shows and present the
    // review on its own. Falls through to the generic rendering below for
    // every other outcome (blocked/skipped/failed), e.g. a critical insight
    // routing this to AwaitHumanReview instead — that path is identical to
    // what /analyze or /explain would show in the same situation.
    if (
      result.context.task.type === "review-code" &&
      lastOutcome?.status === "executed" &&
      lastOutcome.result.kind === "task" &&
      lastOutcome.result.taskResult.success
    ) {
      return this.formatCodeReview(lastOutcome.result.taskResult.output, lastOutcome.result.taskResult.artifacts);
    }

    const lines = [this.field("Plan", this.humanizeRecommendedAction(result.strategy.recommendedAction)), ""];
    for (const outcome of result.stepOutcomes) {
      lines.push(this.formatPipelineStepOutcome(outcome));
    }

    if (lastOutcome?.status === "executed") {
      lines.push("", this.format(lastOutcome.result));
    }

    return lines.join("\n");
  }

  // Phase 12: classifies the same PipelineResult formatPipelineResult()
  // already knows how to render into one of four operator-facing outcomes.
  // By the time this is called, AutonomousExecutionOrchestrator has already
  // awaited the full run -- including any Telegram approval round-trip via
  // TelegramApprovalProvider -- so "approval required" here describes a
  // *discovered fact about the completed run* (a gated step was denied or
  // timed out), not a still-pending state; there is no pending state left to
  // report once attemptExecution() has resolved.
  formatAutonomousExecutionResult(result: PipelineResult | undefined): string {
    if (!result) {
      return "✅ Nothing eligible for autonomous execution right now.";
    }

    // Structurally unreachable from this orchestrator's own translation (it
    // only ever builds "pipeline" requests), but handled honestly rather
    // than assumed away.
    if (result.path === "bypass") {
      return this.template("🤖", "Autonomous Execution Started", [this.format(result.result)]);
    }

    const shipOutcome = result.stepOutcomes.find((outcome) => outcome.capability === "IntegratedDelivery");
    if (!shipOutcome || shipOutcome.status !== "executed" || shipOutcome.result.kind !== "workflow") {
      // A structural gap (blocked) or data gap (skipped) at the outer step,
      // or no IntegratedDelivery step at all -- this orchestrator's own
      // translation always targets the ship workflow, so anything else here
      // is reported as a failure, never silently as success.
      return this.template("❌", "Autonomous Execution Failed", [this.formatPipelineResult(result)]);
    }

    const workflowResult = shipOutcome.result.workflowResult;
    const deniedStep = workflowResult.steps.find(
      (step) => step.executionResult.kind === "task" && step.executionResult.approval?.required === true && !step.executionResult.taskResult.success,
    );
    if (deniedStep && deniedStep.executionResult.kind === "task") {
      const reason = deniedStep.executionResult.taskResult.error ?? "not approved";
      return this.template("⚠️", "Approval Required", [
        this.field("Task", this.code(deniedStep.taskType)),
        this.field("Reason", this.escapeHtml(reason)),
      ]);
    }

    if (result.completed) {
      return this.template("🤖", "Autonomous Execution Started", [this.formatWorkflowResult(workflowResult)]);
    }

    return this.template("❌", "Autonomous Execution Failed", [this.formatWorkflowResult(workflowResult)]);
  }

  // The review's structure (Overall assessment / Strengths / Issues /
  // Recommendations) is produced by ReviewCodeWorkflow's own prompt and
  // returned verbatim in taskResult.output — same trust boundary every other
  // task output already crosses here (format() appends taskResult.output
  // unmodified too, escaped the same way). This only adds the header.
  private formatCodeReview(output: string | undefined, artifacts?: ArtifactMetadata[]): string {
    return this.template("🔍", "Code Review", [
      this.escapeHtml(output ?? "No findings."),
      ...this.artifactsFooterLines(artifacts),
    ]);
  }

  private formatPipelineStepOutcome(outcome: PipelineStepOutcome): string {
    const label = this.humanizeCapability(outcome.capability);
    switch (outcome.status) {
      case "executed": {
        const succeeded = outcome.result.kind === "task" ? outcome.result.taskResult.success : outcome.result.workflowResult.status === "completed";
        return `${succeeded ? "✓" : "✗"} ${label}`;
      }
      case "blocked":
        return `⛔ ${label}: ${this.escapeHtml(outcome.explanation)}\nNext step: ${this.escapeHtml(outcome.recommendedAction)}`;
      case "skipped":
        return `— ${label} skipped: ${this.escapeHtml(outcome.reason)}`;
    }
  }

  // Phase 8.10: the full report — title, health, summary, then every
  // section in the order RuntimeReportingEngine produced them. Every piece
  // of text here (report.title, report.health, report.summary,
  // section.title, section.lines) is used verbatim; only the ordering and
  // blank-line separation between sections is decided here. Not escaped:
  // these are RuntimeReportingEngine's own already-built, internally-sourced
  // strings (uptime, worker counts, policy state), never externally-supplied
  // text the way Claude output or git error messages are.
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

  // Standardizes every "unexpected error" reply TelegramAdapter used to
  // build inline (the same "Something went wrong: ..." string, previously
  // duplicated verbatim at three separate catch sites) into this one place —
  // removes the duplication and keeps TelegramAdapter from doing any
  // presentation work of its own. The error message itself is always
  // externally-influenced (an underlying git/GitHub/Claude/HTTP failure), so
  // it is always escaped.
  formatUnexpectedError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return `⚠️ Something went wrong: ${this.escapeHtml(message)}`;
  }

  // The one place a CommandParser rejection (invalid syntax, missing
  // argument, unrecognized command) becomes a reply — previously sent to the
  // user as TelegramAdapter's raw error.message, with no icon and no
  // consistent styling, unlike every other refusal in this class. The
  // message's actual wording still belongs entirely to CommandParser; this
  // only wraps it the same way every other warning-shaped reply is wrapped.
  formatCommandError(message: string): string {
    return `⚠️ ${this.escapeHtml(message)}`;
  }

  // A static literal, same as formatHelp() -- kept here rather than inline
  // in TelegramAdapter so every single reply TelegramAdapter sends, with no
  // exception, is built by this class.
  formatUnauthorized(): string {
    return "🚫 You are not authorized to use this bot.";
  }

  formatArtifactList(list: ArtifactList): string {
    if (list.items.length === 0) {
      return "No artifacts stored yet. Artifacts appear here after /analyze, /review, or /fix.";
    }
    const lines = list.items.map((item) => this.artifactSummaryLine(item));
    const suffix = list.cursor
      ? `(showing ${list.items.length} of ${list.total}; use /artifact search to narrow the list)`
      : `(${list.total} total)`;
    return this.template("📦", "Artifacts", [...lines, "", suffix, "Use /artifact get <id> to download."]);
  }

  formatArtifactSearchResults(query: string, list: ArtifactList): string {
    if (list.items.length === 0) {
      return `No artifacts match "${this.escapeHtml(query)}".`;
    }
    const lines = list.items.map((item) => this.artifactSummaryLine(item));
    const matchWord = list.total === 1 ? "match" : "matches";
    return this.template("🔎", `Artifact search: "${this.escapeHtml(query)}"`, [
      ...lines,
      "",
      `${list.total} ${matchWord}. Use /artifact get <id> to download.`,
    ]);
  }

  formatArtifactNotFound(id: string): string {
    return `No artifact found with id "${this.escapeHtml(id)}".`;
  }

  formatArtifactCaption(metadata: ArtifactMetadata): string {
    return [
      this.field("Artifact", this.escapeHtml(metadata.title)),
      this.field("Type", this.code(metadata.type)),
      this.field("Size", this.formatBytes(metadata.size)),
    ].join("\n");
  }

  formatArtifactDeleteResult(id: string, existed: boolean): string {
    return existed ? `Deleted artifact ${this.code(id)}.` : `No artifact found with id "${this.escapeHtml(id)}"; nothing deleted.`;
  }

  formatArtifactIndexRebuildResult(result: { before: number; after: number; elapsedMs: number }): string {
    return this.template("🔧", "Artifact Index Rebuilt", [
      this.field("Elapsed", `${result.elapsedMs}ms`),
      this.field("Before", String(result.before)),
      this.field("After", String(result.after)),
    ]);
  }

  // --- Shared template/escaping helpers -------------------------------
  //
  // The one presentation template every format* method above builds on:
  // a bold "<icon> <Title>" header, a blank line, then already-composed
  // content lines. Kept intentionally tiny (no config, no variants) so it
  // can't drift into a second, competing layout convention the way the
  // pre-unification formatters had.
  private template(icon: string, title: string, lines: string[]): string {
    return [this.bold(`${icon} ${title}`), "", ...lines].join("\n");
  }

  // label is always a literal, static string this class itself wrote —
  // never escaped, and never allowed to carry externally-supplied text.
  // value must already be escaped (or wrapped via code()) by the caller
  // whenever it originates outside this class.
  private field(label: string, value: string): string {
    return `${this.bold(`${label}:`)} ${value}`;
  }

  private bold(text: string): string {
    return `<b>${text}</b>`;
  }

  // For identifier-shaped values (branch/repository names, file paths,
  // correlation/checkpoint ids, task types, capability/workflow ids) —
  // always escapes internally, so every call site is safe by construction
  // regardless of whether the specific value strictly needed escaping.
  private code(text: string): string {
    return `<code>${this.escapeHtml(text)}</code>`;
  }

  // Delegates to the one shared escaping helper (see TelegramHtml.ts) rather
  // than keeping its own copy -- TelegramApprovalProvider and
  // TelegramAttentionTransport, the only other two places that build message
  // text outside this class, use the exact same function. Applied only to
  // externally-supplied text (Claude output, git/API error messages, file
  // paths, branch names, free-text reasons) — never to this class's own
  // static labels/titles, which are trusted literals it wrote itself.
  private escapeHtml(text: string): string {
    return escapeHtml(text);
  }

  // Shared by every bullet list in this class (branches, insights,
  // recommendations, undo file lists) — caps the number of items actually
  // rendered so a large result can never flood the chat, collapsing the
  // remainder into a single "...and N more" line. Callers pass
  // already-escaped/already-coded items; this never touches their content.
  private truncateBulletList(items: string[], limit = 10, bullet = "• "): string[] {
    const shown = items.slice(0, limit).map((item) => `${bullet}${item}`);
    if (items.length > limit) {
      shown.push(`...and ${items.length - limit} more`);
    }
    return shown;
  }

  private humanizeRecommendedAction(action: RecommendedAction): string {
    return RECOMMENDED_ACTION_LABELS[action];
  }

  private humanizeCapability(capability: Capability): string {
    return CAPABILITY_LABELS[capability];
  }

  // Relative for anything recent enough that "how long ago" is the useful
  // fact (history entries, session activity, a running task's own start
  // time); falls back to an unambiguous absolute UTC timestamp once a date
  // is old enough that "N days ago" stops being a precise-enough answer.
  private formatTimestamp(date: Date): string {
    const diffSeconds = Math.round((Date.now() - date.getTime()) / 1000);
    if (diffSeconds < 5) return "just now";
    if (diffSeconds < 60) return `${diffSeconds}s ago`;
    const diffMinutes = Math.round(diffSeconds / 60);
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    const diffHours = Math.round(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.round(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  }

  // Shared by format()/formatCodeReview() -- the footer appended to a task's
  // own reply when TaskArtifactRecorder produced anything for it. Empty
  // (never a trailing blank section) when artifacts is undefined or empty,
  // so a task type this class never records for renders identically to
  // before artifacts existed.
  private artifactsFooterLines(artifacts?: ArtifactMetadata[]): string[] {
    if (!artifacts || artifacts.length === 0) {
      return [];
    }
    const items = artifacts.map((artifact) => this.artifactSummaryLine(artifact));
    return ["", this.bold("📎 Artifacts"), ...this.truncateBulletList(items), "Use /artifact get <id> to download."];
  }

  private artifactSummaryLine(artifact: Pick<ArtifactMetadata, "id" | "title" | "type" | "size">): string {
    return `${this.code(artifact.id)} ${this.escapeHtml(artifact.title)} (${this.escapeHtml(artifact.type)}, ${this.formatBytes(artifact.size)})`;
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  private formatDuration(durationMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }
}
