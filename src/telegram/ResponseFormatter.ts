import type { ArtifactDeletionResult, ArtifactList, ArtifactMetadata } from "../artifacts";
import type { ExecutionResult, OrchestrationResult } from "../controller/types";
import type { Insight, RepositoryInsightReport } from "../decisions/types";
import type { CurrentTaskReport, TaskCancellationOutcome } from "../executionstate/types";
import type {
  CommitCreationResult,
  CommitDetail,
  CommitDiffStatResult,
  CommitSummary,
  DiscardOutcome,
  DiscardPlan,
  GitFileChange,
  GitHistoryResult,
  PushResult,
  RepositoryHealthReport,
  WorkingTreeChange,
  WorkingTreeChangeDiff,
  WorkingTreeChangesResult,
} from "../git/types";
import type { ConflictResolutionOutcome } from "../gitengines/types";
import type { RecoveryOutcome } from "../recovery/types";
import type { UndoOutcome } from "../undo/types";
import type { RepositorySnapshot } from "../intelligence/types";
import type { FailureClearResult, ProjectMemoryEvent, TaskFailureStatus } from "../memory/types";
import type { PipelineContext, PipelineResult, PipelineStepOutcome } from "../pipeline/types";
import { TASK_CANCELLED_MESSAGE } from "../planner/errors";
import type { Recommendation, RepositoryRecommendationReport } from "../recommendations/types";
import type { RuntimeReport, RuntimeReportSection } from "../reporting/types";
import type { SessionLifecycleState, SessionReport, SessionStopOutcome } from "../session/types";
import type { Capability } from "../coordination/types";
import type { RecommendedAction } from "../strategy/types";
import type { IResponseFormatter } from "./interfaces";
import { MAX_HISTORY_KEYBOARD_ITEMS } from "./TelegramConstants";
import { escapeHtml } from "./TelegramHtml";

// Working Tree Management (/showchanges): a single file's diff can
// legitimately run long (a generated lockfile, a large rewrite) -- capped
// independently of TELEGRAM_MAX_MESSAGE_LENGTH's own chunking so one huge
// diff never dominates the reply; the same "cap + say how much more" spirit
// truncateBulletList already applies to lists, just line-based instead of
// item-based since a diff's own line structure (hunks, +/- prefixes) has to
// stay intact for it to remain readable.
const MAX_DIFF_DISPLAY_LINES = 200;

// Commit and Push Result Messages (push-changes): how many individually
// listed commits a "✅ Push Successful" reply shows before collapsing the
// rest into "...and N more" -- same truncateBulletList-style cap as every
// other list in this file, keeping a large push's summary compact and
// mobile-readable rather than dumping every commit message into one message.
const MAX_PUSHED_COMMITS_SHOWN = 10;

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
  "/insights",
  "/failures",
  "/clear-failures",
  "/clear-failures &lt;taskType&gt;",
  "/session",
  "/session reset",
  "/session stop",
  "/recommendations",
  "/task",
  "/task cancel",
  "/task history [limit]",
  "/undo",
  "/undo &lt;hash&gt;",
  "/undo confirm",
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
  "/rebase [onto]",
  "/discard",
  "/recover",
  "/health",
  "/resume",
  "/abort",
  "",
  "Working Tree Management",
  "/changes",
  "/showchanges &lt;index&gt;",
  "/discard &lt;index&gt;",
  "/discard &lt;index&gt; confirm",
  "/discard all",
  "/discard all confirm",
  "",
  "Git History & Inspection",
  "/history [count]",
  "/history branch:&lt;name&gt;",
  "/history author:&lt;name&gt;",
  "/history search:&lt;text&gt;",
  "/show &lt;hash&gt;",
  "/diff &lt;hash&gt;",
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

    // Commit and Push Result Messages: CreateCommitWorkflow/PushChangesWorkflow
    // populate these two structured fields (see WorkflowResult's own doc
    // comment) only on success -- the `undefined` fallback below only fires
    // if a caller somehow produced a successful create-commit/push-changes
    // TaskResult without going through those workflows (e.g. a future test
    // double), never in real operation.
    if (taskResult.taskType === "create-commit") {
      return taskResult.commitCreated
        ? this.formatCommitCreated(taskResult.repositoryId, taskResult.commitCreated)
        : this.template("✅", "Commit Created", [this.field("Task", this.code(taskResult.taskType))]);
    }
    if (taskResult.taskType === "push-changes") {
      return taskResult.pushCompleted
        ? this.formatPushCompleted(taskResult.repositoryId, taskResult.pushCompleted)
        : this.template("✅", "Push Successful", [this.field("Task", this.code(taskResult.taskType))]);
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
      this.field("Implementation Status", this.describeImplementationSafety(branch)),
    ]);
  }

  // Branch Blocking Observability: a read-only, presentational label so
  // /status answers "would implement-feature/fix-bug be blocked right now"
  // without waiting for an actual blocked attempt. Deliberately NOT a call
  // into StrategyEngine and NOT reused by it -- this recomputes the same two
  // RepositorySnapshot.branch fields StrategyEngine's own implement-feature/
  // fix-bug rule compares (see StrategyEngine.resolveRecommendedAction), as
  // an entirely independent, display-only read with no path back into any
  // decision. If that rule's inputs ever change, this label and
  // StrategyEngine's actual behavior could in principle diverge -- an
  // accepted tradeoff for keeping this a pure formatter concern with zero
  // coupling to the decision engine, per this feature's own constraint of
  // never touching StrategyEngine or the branch validation rule itself.
  private describeImplementationSafety(branch: RepositorySnapshot["branch"]): string {
    return branch.current === branch.default ? "⛔ Protected branch" : "✅ Safe for implementation";
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
      // Git Orchestration redesign: produced when Safe Undo Framework's plan
      // was the more recent of the two undo mechanisms -- see
      // ApplicationService.undoLastExecution()'s own doc comment.
      case "git-undone":
        return this.template("↩️", "Undo Complete", [this.field("Operation", this.code(outcome.operation))]);
      // Git History & Inspection System: a bare "/undo" -- nothing executed,
      // just a reference list of recent commits to reply to.
      case "preview": {
        if (outcome.commits.length === 0) {
          return "✅ No commits found — nothing to undo yet.";
        }
        return this.template("↩️", "Recent Commits", [
          ...outcome.commits.map((commit, index) => `${index + 1}. ${this.code(commit.shortSha)} ${this.escapeHtml(commit.message)}`),
          "",
          "Reply with /undo &lt;hash&gt; to undo it, or /undo confirm to undo without a commit reference.",
        ]);
      }
      // "/undo <hash>" where <hash> isn't what would actually be undone.
      case "target-mismatch-git":
        return this.template("⚠️", "Cannot Undo", [
          `The most recent undoable change is ${this.code(outcome.operation)} (commit ${this.code(this.shortRef(outcome.expectedHash))}), not ${this.code(outcome.givenTarget)}.`,
          "",
          `Reply with /undo ${this.escapeHtml(this.shortRef(outcome.expectedHash))} or /undo confirm.`,
        ]);
      // Post-incident fix: "/undo <hash>" where no undoable Git operation
      // exists at all -- an explicit hash is resolved against the single
      // latest Git journal entry only (product decision: historical/older
      // hash lookup is out of scope, see ApplicationService.undoLastExecution()'s
      // own doc comment), so this is reported plainly rather than silently
      // falling back to a task-snapshot candidate the user never asked for.
      case "target-not-found-git":
        return this.template("⚠️", "Cannot Undo", [
          `No undoable Git operation matches ${this.code(outcome.givenTarget)}.`,
          "",
          "Send /undo (no arguments) to see recent commits, or /undo confirm to undo the most recent change.",
        ]);
      // "/undo <hash>" where the candidate is a Claude-editing task snapshot
      // -- no commit hash exists to match against.
      case "target-requires-confirm":
        return this.template("⚠️", "Cannot Undo", [
          `The most recent undoable change is uncommitted work from a Claude task (${this.code(outcome.taskType)}), which has no commit hash.`,
          "",
          "Reply with /undo confirm to undo it.",
        ]);
      // "/undo <hash>" where the candidate is a git-native operation
      // (switch-branch/create-branch) with no commit to reference at all --
      // never labeled "commit X" the way target-mismatch-git is, since
      // there is no commit here, only a branch name.
      case "target-requires-confirm-git":
        return this.template("⚠️", "Cannot Undo", [
          `The most recent undoable change is ${this.code(outcome.operation)}, which has no commit to reference.`,
          "",
          "Reply with /undo confirm to undo it.",
        ]);
    }
  }

  // Git History & Inspection System: /history -- each commit shown as
  // "<index>. <hash> <message>" plus a second line of author/relative time,
  // with a "← <branch>" marker on whichever commit is the branch tip.
  formatGitHistory(result: GitHistoryResult): string {
    if (result.commits.length === 0) {
      return "✅ No commits found for this repository.";
    }

    const lines = result.commits.flatMap((commit, index) => [
      `${index + 1}. ${this.code(commit.shortSha)} ${this.escapeHtml(commit.message)}`,
      `   ${this.escapeHtml(commit.author)} · ${this.formatTimestamp(commit.date)}${this.currentBranchMarker(commit, result)}`,
    ]);

    // Quick-action buttons are capped independently of this list (see
    // TelegramAdapter.handleGitHistory) -- every commit above is still
    // listed and still addressable via the manual commands regardless of
    // this note, which only exists so a long list doesn't leave the user
    // wondering why buttons stopped appearing partway down it.
    const keyboardNote =
      result.commits.length > MAX_HISTORY_KEYBOARD_ITEMS
        ? [`Quick-action buttons are shown for the first ${MAX_HISTORY_KEYBOARD_ITEMS} commits only -- use the commands below for the rest.`, ""]
        : [];

    return this.template("📜", "Recent Commits", [
      ...lines,
      "",
      ...keyboardNote,
      "Available commands: /show &lt;hash&gt;, /diff &lt;hash&gt;, /undo &lt;hash&gt;.",
    ]);
  }

  private currentBranchMarker(commit: CommitSummary, result: GitHistoryResult): string {
    if (result.detachedHead || commit.sha !== result.headSha || !result.currentBranch) {
      return "";
    }
    return ` ← ${this.code(result.currentBranch)}`;
  }

  // Git History & Inspection System: /show <hash>.
  formatCommitDetail(detail: CommitDetail): string {
    const lines = [
      this.field("Commit", this.code(detail.sha)),
      this.field("Short", this.code(detail.shortSha)),
      this.field("Author", `${this.escapeHtml(detail.authorName)} &lt;${this.escapeHtml(detail.authorEmail)}&gt;`),
      this.field("Date", this.formatAbsoluteTimestamp(detail.authorDate)),
      this.field("Relative", this.formatTimestamp(detail.authorDate)),
    ];
    if (detail.currentBranch) {
      lines.push(this.field("Branch", `${this.code(detail.currentBranch)} (HEAD)`));
    }
    lines.push(
      this.field("Parent(s)", detail.parents.length > 0 ? detail.parents.map((parent) => this.code(parent)).join(", ") : "none (root commit)"),
    );
    lines.push("", this.escapeHtml(detail.subject));

    lines.push(
      "",
      `Files Changed (${detail.filesChanged}):`,
      ...this.truncateBulletList(
        detail.files.map((file) => `${this.humanizeFileStatus(file.status)}: ${this.code(file.path)}`),
        20,
      ),
    );
    lines.push("", `${detail.filesChanged} file(s) changed, +${detail.insertions} insertions, -${detail.deletions} deletions`);

    return this.template("🔎", "Commit Detail", lines);
  }

  private humanizeFileStatus(status: GitFileChange["status"]): string {
    switch (status) {
      case "added":
        return "Added";
      case "modified":
        return "Modified";
      case "deleted":
        return "Deleted";
    }
  }

  // Commit and Push Result Messages (create-commit): everything needed to
  // verify a commit from Telegram alone -- repository, branch, hash, the
  // full commit message, the changed-file list, and aggregate stats, in the
  // same compact "Label: value" style every other command in this file
  // already uses (not the requesting spec's own vertical label-then-value
  // layout -- that reads fine on a form, but roughly doubles the line count
  // for no added information, working against "keep messages compact" on a
  // phone screen).
  private formatCommitCreated(repositoryId: string | undefined, result: CommitCreationResult): string {
    const lines = [
      this.field("Repository", this.code(repositoryId ?? "unknown")),
      this.field("Branch", this.code(result.branch)),
      this.field("Commit Hash", this.code(result.shortSha)),
      "",
      this.escapeHtml(result.message),
      "",
      `Files Changed (${result.filesChanged}):`,
      ...this.truncateBulletList(result.files.map((file) => `${this.humanizeFileStatus(file.status)}: ${this.code(file.path)}`), 20),
      "",
      `${result.filesChanged} file(s) changed, +${result.insertions} insertions, -${result.deletions} deletions`,
      "",
      this.field("Timestamp", this.formatAbsoluteTimestamp(result.timestamp)),
    ];
    return this.template("✅", "Commit Created", lines);
  }

  // Commit and Push Result Messages (push-changes). No GitHub URL field when
  // PushResult.githubUrl is undefined (a non-github.com remote, or none
  // configured) -- shown as a bare, unescaped-for-markup URL rather than an
  // <a href> anchor: Telegram auto-links plain https:// URLs in HTML-mode
  // text on its own, so there is no need for an anchor tag (and no risk of
  // TelegramMessageSplitter ever having to split one in half, unlike <pre>).
  private formatPushCompleted(repositoryId: string | undefined, result: PushResult): string {
    const lines = [
      this.field("Repository", this.code(repositoryId ?? "unknown")),
      this.field("Remote", this.code(result.remote)),
      this.field("Branch", this.code(result.branch)),
      this.field("Commit Hash", this.code(result.headShortSha)),
      "",
      this.escapeHtml(result.headMessage),
      "",
      ...this.formatPushedCommitsSection(result.pushedCommits),
      this.field(
        "Remote Status",
        `${this.code(`${result.remote}/${result.branch}`)} (ahead ${result.ahead}, behind ${result.behind})`,
      ),
    ];
    if (result.githubUrl) {
      lines.push(this.field("GitHub", this.escapeHtml(result.githubUrl)));
    }
    lines.push("", this.field("Timestamp", this.formatAbsoluteTimestamp(result.timestamp)));
    return this.template("✅", "Push Successful", lines);
  }

  // A no-op push ("Everything up-to-date") is a normal, successful outcome,
  // not an error -- rendered as "0 (already up to date)" rather than an
  // empty, unexplained bullet list. Each pushed commit gets its own two-line
  // entry (hash, then message) with a blank line between entries, matching
  // the spec's own "• hash / message" example -- unlike every other bulleted
  // list in this file (truncateBulletList), which is always one line per
  // item.
  private formatPushedCommitsSection(commits: CommitSummary[]): string[] {
    if (commits.length === 0) {
      return [this.field("Pushed Commits", "0 (already up to date)"), ""];
    }

    const shown = commits.slice(0, MAX_PUSHED_COMMITS_SHOWN);
    const bullets = shown.flatMap((commit) => [`• ${this.code(commit.shortSha)}`, `  ${this.escapeHtml(commit.message)}`, ""]);
    if (commits.length > MAX_PUSHED_COMMITS_SHOWN) {
      bullets.push(`...and ${commits.length - MAX_PUSHED_COMMITS_SHOWN} more`, "");
    }
    return [this.field("Pushed Commits", String(commits.length)), "", ...bullets];
  }

  // Git History & Inspection System: /diff <hash> -- a structured per-file
  // +/- summary, deliberately never the raw unified patch (GitAdapter.diff()
  // exists for that, but this command's whole point is a scannable summary).
  formatCommitDiff(result: CommitDiffStatResult): string {
    const header = [this.field("Commit", this.code(result.shortSha))];

    if (result.files.length === 0) {
      return this.template("📊", "Diff", [...header, "", "No file changes (empty commit)."]);
    }

    const fileLines = result.files.flatMap((file) => [
      this.code(file.path),
      file.binary ? "  binary file" : `  +${file.insertions} -${file.deletions}`,
    ]);

    return this.template("📊", "Diff", [
      ...header,
      "",
      ...fileLines,
      "",
      `Summary: ${result.filesChanged} file(s) changed, +${result.insertions} insertions, -${result.deletions} deletions`,
    ]);
  }

  // Git Orchestration redesign: /health -- a direct, read-only rendering of
  // RepositoryHealthReport. Only ever shows a field when it is actually
  // informative (upstream/in-progress-operation/interrupted-operation/
  // stale-lock/stash), the same "no line for a fact that isn't there"
  // discipline formatRepositoryStatus() already follows.
  formatRepositoryHealth(report: RepositoryHealthReport): string {
    const lines = [
      this.field("Branch", report.detachedHead ? "detached HEAD" : this.code(report.branch)),
      this.field(
        "Working tree",
        report.isClean
          ? "clean"
          : `${report.staged.length} staged, ${report.unstaged.length} unstaged, ${report.untracked.length} untracked`,
      ),
    ];
    if (report.upstream) {
      const divergedSuffix = report.upstream.diverged ? " -- diverged" : "";
      lines.push(this.field("Upstream", `${this.code(report.upstream.ref)} (${report.upstream.ahead} ahead, ${report.upstream.behind} behind)${divergedSuffix}`));
    }
    if (report.inProgressOperation) {
      lines.push(this.field("In progress", this.code(report.inProgressOperation.kind)));
    }
    if (report.locks.staleLockDetected) {
      lines.push(this.field("Stale lock", "detected"));
    }
    if (report.stashCount > 0) {
      lines.push(this.field("Stashes", String(report.stashCount)));
    }
    if (report.interruptedOperation) {
      lines.push("", "⚠️ An interrupted operation was detected. Run /recover before trying another command.");
    }

    const icon = report.interruptedOperation ? "🚨" : report.inProgressOperation ? "⚠️" : report.isClean ? "✅" : "🟡";
    return this.template(icon, "Repository Health", lines);
  }

  // /recover -- ApplicationService.recoverRepository() either found nothing
  // to recover (a normal, renderable outcome) or ran Repository Recovery
  // Workflow's plan and returned a RecoveryOutcome; stoppedAtStep undefined
  // means every step completed.
  formatRecoveryResult(outcome: RecoveryOutcome | { kind: "nothing-to-recover" }): string {
    if (!("planId" in outcome)) {
      return "✅ Nothing to recover -- the repository is in a normal operating state.";
    }
    const lines = [
      this.field("Completed steps", String(outcome.completedSteps.length)),
      this.field("Final state", this.code(outcome.finalState)),
    ];
    if (outcome.stoppedAtStep) {
      lines.push(this.field("Stopped at", this.code(outcome.stoppedAtStep)));
    }
    const icon = outcome.stoppedAtStep ? "⚠️" : "✅";
    return this.template(icon, "Recovery", lines);
  }

  // /resume -- mirrors ConflictResolutionEngine.resolve()'s three outcomes
  // plus the "nothing was actually in progress" case ApplicationService
  // checks for before ever calling it.
  formatResumeResult(outcome: ConflictResolutionOutcome | { kind: "nothing-to-resume" }): string {
    switch (outcome.kind) {
      case "nothing-to-resume":
        return "✅ Nothing to resume -- no merge or rebase is currently in progress.";
      case "resolved":
        return this.template("✅", "Resumed", [
          `Resolved and completed (${outcome.filesResolved.length} file(s)):`,
          ...this.truncateBulletList(outcome.filesResolved.map((file) => this.code(file))),
        ]);
      case "aborted":
        return this.template("🛑", "Aborted", ["Remaining conflicts could not be auto-resolved, and abort was approved."]);
      case "needs-guidance":
        return this.template("⚠️", "Still Conflicted", [
          `${outcome.unresolvedFiles.length} file(s) still need manual resolution:`,
          ...this.truncateBulletList(outcome.unresolvedFiles.map((file) => this.code(file))),
          "",
          "Resolve them by hand, then run /resume again.",
        ]);
    }
  }

  // /abort -- the fast, direct escape hatch; distinct wording from /recover
  // and /resume above since it performs no plan and asks no questions.
  formatAbortResult(outcome: { kind: "aborted"; operation: string } | { kind: "nothing-to-abort" }): string {
    if (outcome.kind === "nothing-to-abort") {
      return "✅ Nothing to abort -- no merge, rebase, cherry-pick, revert, or bisect is currently in progress.";
    }
    return this.template("🛑", "Aborted", [this.field("Operation", this.code(outcome.operation))]);
  }

  // Working Tree Management: /changes -- grouped by status in a fixed order
  // (Modified, Added, Deleted, Renamed, Untracked), each file numbered with
  // its own change.index (assigned once, by WorkingTreeService, in the exact
  // same order this method groups by -- see WorkingTreeChange's own doc
  // comment) so the numbers shown here are always exactly what
  // /showchanges/<index> and /discard <index> will resolve.
  formatWorkingTreeChanges(result: WorkingTreeChangesResult): string {
    if (result.changes.length === 0) {
      return "✅ Clean working tree — no local changes.";
    }

    const lines: string[] = [];
    this.pushWorkingTreeChangeSection(lines, "Modified", result.changes.filter((change) => change.status === "modified"));
    this.pushWorkingTreeChangeSection(lines, "Added", result.changes.filter((change) => change.status === "added"));
    this.pushWorkingTreeChangeSection(lines, "Deleted", result.changes.filter((change) => change.status === "deleted"));
    this.pushWorkingTreeChangeSection(lines, "Renamed", result.changes.filter((change) => change.status === "renamed"));
    this.pushWorkingTreeChangeSection(lines, "Untracked", result.changes.filter((change) => change.status === "untracked"));

    lines.push(
      "",
      `Staged: ${result.stagedCount} · Unstaged: ${result.unstagedCount} · Untracked: ${result.untrackedCount}`,
      "",
      "Use /showchanges &lt;index&gt; to view a diff, /discard &lt;index&gt; to discard one file, or /discard all to discard everything.",
    );

    return this.template("📝", "Working Tree Changes", lines);
  }

  private pushWorkingTreeChangeSection(lines: string[], title: string, changes: WorkingTreeChange[]): void {
    if (changes.length === 0) {
      return;
    }
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(`${title}:`);
    for (const change of changes) {
      const label = change.renamedFrom ? `${this.code(change.renamedFrom)} → ${this.code(change.path)}` : this.code(change.path);
      lines.push(`${change.index}. ${label}`);
    }
  }

  // /showchanges <index> -- the raw diff, monospaced (Telegram HTML <pre>),
  // line-truncated (see MAX_DIFF_DISPLAY_LINES's own doc comment). Unlike
  // formatCommitDiff (a structured +/- summary across possibly many files),
  // this is always exactly one file, so the actual patch content is what's
  // useful here, not a stat line.
  formatWorkingTreeChangeDiff(result: WorkingTreeChangeDiff): string {
    const { change, diff } = result;
    const header = [
      this.field("File", change.renamedFrom ? `${this.code(change.renamedFrom)} → ${this.code(change.path)}` : this.code(change.path)),
      this.field("Status", this.humanizeWorkingTreeStatus(change.status)),
    ];

    const trimmed = diff.trim();
    if (!trimmed) {
      return this.template("🔍", "File Diff", [...header, "", "(no textual diff)"]);
    }

    const diffLines = trimmed.split("\n");
    const shown = diffLines.slice(0, MAX_DIFF_DISPLAY_LINES);
    const bodyLines = [...shown];
    if (diffLines.length > MAX_DIFF_DISPLAY_LINES) {
      bodyLines.push(`... and ${diffLines.length - MAX_DIFF_DISPLAY_LINES} more line(s)`);
    }

    return this.template("🔍", "File Diff", [...header, "", `<pre>${this.escapeHtml(bodyLines.join("\n"))}</pre>`]);
  }

  private humanizeWorkingTreeStatus(status: WorkingTreeChange["status"]): string {
    switch (status) {
      case "modified":
        return "Modified";
      case "added":
        return "Added";
      case "deleted":
        return "Deleted";
      case "renamed":
        return "Renamed";
      case "untracked":
        return "Untracked";
    }
  }

  // /discard <index> [confirm], /discard all [confirm] -- result is exactly
  // what ApplicationService.discardWorkingTreeChange()/discardAllWorkingTreeChanges()
  // returned: a DiscardOutcome (kind: "discarded") once actually executed, or
  // a DiscardPlan (unconfirmed, or refused) otherwise -- every branch is laid
  // out here, never decided here.
  formatDiscardResult(result: DiscardPlan | DiscardOutcome): string {
    // DiscardPlan and DiscardOutcome have no shared discriminant property
    // (DiscardPlan carries "status", DiscardOutcome carries "kind") -- `in`
    // narrows correctly here even though a plain `result.kind === ...` check
    // would not (DiscardPlan has no "kind" property at all to compare
    // against).
    if ("kind" in result) {
      return this.template("🗑️", "Discard Complete", [
        `Affected Files (${result.affectedFiles.length}):`,
        ...this.truncateBulletList(result.affectedFiles.map((file) => this.code(file))),
        "",
        result.isClean
          ? "Working tree is now clean."
          : `Staged: ${result.stagedCount} · Unstaged: ${result.unstagedCount} · Untracked: ${result.untrackedCount}`,
      ]);
    }

    switch (result.status) {
      case "nothing-to-discard":
        return "✅ Nothing to discard — the working tree is already clean.";
      case "execution-in-progress":
        return this.template("⚠️", "Cannot Discard", ["A task is currently running for this repository."]);
      case "operation-in-progress":
        return this.template("⚠️", "Cannot Discard", [
          "A merge, rebase, or other git operation is currently in progress. Resolve it first (see /health), or /resume, or /abort.",
        ]);
      case "ready": {
        if (result.target.kind === "index") {
          const [file] = result.changes;
          return this.template("⚠️", "Discard Changes?", [
            this.field("File", this.code(file.path)),
            this.field("Status", this.humanizeWorkingTreeStatus(file.status)),
            "",
            `This cannot be undone through /discard itself, but is recoverable via ${this.code("/undo confirm")} immediately afterward.`,
            "",
            `Reply: ${this.code(`/discard ${result.target.index} confirm`)}`,
          ]);
        }
        return this.template("⚠️", "Discard All Changes?", [
          `This will discard all ${result.changes.length} local change(s):`,
          ...this.truncateBulletList(result.changes.map((change) => this.code(change.path))),
          "",
          `Staged: ${result.stagedCount} · Unstaged: ${result.unstagedCount} · Untracked: ${result.untrackedCount}`,
          "",
          `This cannot be undone through /discard itself, but is recoverable via ${this.code("/undo confirm")} immediately afterward.`,
          "",
          `Reply: ${this.code("/discard all confirm")}`,
        ]);
      }
    }
  }

  private shortId(id: string): string {
    return id.slice(0, 8);
  }

  // Git History & Inspection System: a git short hash is conventionally 7
  // characters, distinct from shortId's 8 (a checkpoint id, not a git sha).
  private shortRef(sha: string): string {
    return sha.slice(0, 7);
  }

  private describeWorkingTree(workingTree: RepositorySnapshot["workingTree"]): string {
    return workingTree.isClean
      ? "clean"
      : `${workingTree.staged.length} staged, ${workingTree.unstaged.length} unstaged, ${workingTree.untracked.length} untracked`;
  }

  // Renamed from formatHistory: reachable only via "/task history" now --
  // see IApplicationService.getTaskExecutionHistory()'s own doc comment.
  formatTaskHistory(events: ProjectMemoryEvent[]): string {
    if (events.length === 0) {
      return "No recorded history for this repository.";
    }

    // Deliberately no additional truncation here, unlike the other list
    // views: the caller already controls exactly how many events are
    // returned via /task history's own optional limit argument
    // (ApplicationService.getTaskExecutionHistory -> ProjectMemoryService's
    // own limit, default 20) -- imposing a second, independent display cap
    // on top of a limit the user explicitly asked for would silently
    // override their own request rather than just presenting it.
    return this.template("📜", "Task History", events.map((event) => this.formatHistoryEvent(event)));
  }

  private formatHistoryEvent(event: ProjectMemoryEvent): string {
    const timestamp = this.formatTimestamp(event.recordedAt);

    if (event.outcome.kind === "error") {
      return `✗ error: ${this.escapeHtml(event.outcome.error)} (${timestamp})`;
    }
    if (event.outcome.kind === "undo") {
      return `↩️ undo (checkpoint ${this.code(this.shortId(event.outcome.undoneCheckpointId))}) (${timestamp})`;
    }
    // Repository Failure Policy redesign: /clear-failures' own audit event --
    // rendered in /task history the same way "undo" already is, since both
    // are targeted, non-execution writes into the same event log.
    if (event.outcome.kind === "failure-state-cleared") {
      return `🧯 failure counters cleared${event.outcome.taskType ? ` (${this.code(event.outcome.taskType)})` : " (all task types)"} (${timestamp})`;
    }
    // Branch Blocking Observability: an audit-only record of a pipeline
    // stage that blocked before ControllerCore.execute() was ever reached --
    // rendered here the same way "undo"/"failure-state-cleared" already are,
    // never as a task success/failure.
    if (event.outcome.kind === "pipeline-blocked") {
      return `⛔ ${this.humanizeCapability(event.outcome.pipelineStage)} blocked ${this.code(event.outcome.taskType)} (branch: ${this.code(event.outcome.currentBranch)}) (${timestamp})`;
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

  // Repository Failure Policy redesign: /failures. `status` on each entry is
  // precomputed by ApplicationService.getFailureStatus from DecisionEngine's
  // own threshold constants -- this method has no threshold knowledge of its
  // own, only three fixed label/icon pairs. Ordered blocked -> warning ->
  // healthy, then alphabetically by task type within each group (see
  // ApplicationService.getFailureStatus).
  // Failure State Self-Healing: each task type now renders as its own small
  // block (task type, status, and -- for anything not healthy -- the
  // consecutive count plus Last Failure/Last Success timestamps) separated
  // by a dashed rule, rather than one line per task type, so the operational
  // context (when did this last fail, has it ever succeeded) that makes
  // troubleshooting from Telegram actually useful is visible without a
  // second command. A healthy task type stays a compact two-line block --
  // there's nothing operationally interesting to show once nothing is
  // wrong.
  formatFailureStatus(states: TaskFailureStatus[]): string {
    if (states.length === 0) {
      return "✅ No task types have recorded any executions yet.";
    }

    const blocks = states.map((state) => {
      if (state.status === "healthy") {
        return [this.code(state.taskType), "Healthy"].join("\n");
      }
      const label = state.status === "blocked" ? "🔴 BLOCKED" : "⚠ WARNING";
      const lines = [this.code(state.taskType), `Status: ${label}`, `Consecutive Failures: ${state.consecutiveFailures}`];
      if (state.lastFailure) {
        lines.push("Last Failure:", this.formatAbsoluteTimestamp(state.lastFailure));
      }
      if (state.lastSuccess) {
        lines.push("Last Success:", this.formatAbsoluteTimestamp(state.lastSuccess));
      }
      return lines.join("\n");
    });

    return this.template("🧯", "Repository Failure Summary", [blocks.join(`\n${"-".repeat(34)}\n`)]);
  }

  // /clear-failures [taskType] -- always a plain confirmation, since
  // ApplicationService.clearFailures always succeeds (a derived counter
  // reset, never a destructive operation gated on confirmation).
  formatClearFailuresResult(result: FailureClearResult): string {
    return result.taskType
      ? `✅ ${this.escapeHtml(result.taskType)} failure counter cleared.\nRepository is operational again.`
      : "✅ All repository failure counters cleared.";
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

    // Branch Blocking Observability: a "blocked" step is always the terminal
    // outcome (dispatch() stops at the first blocked/skipped step, so it can
    // only ever be last() -- see ExecutionPipeline.dispatch()). Rendered as
    // its own self-contained block with full decision context (repository,
    // current/default branch, reason, recommendation, decision time) instead
    // of folded into the generic per-step checklist below, so the reply to a
    // blocked request answers "why, on which branch, at what time" on its
    // own -- this is precisely the information whose absence caused
    // confusion when a repository's branch changed shortly after a blocked
    // request (see the gcpay-backend investigation this feature followed
    // from).
    if (lastOutcome?.status === "blocked") {
      return this.formatBlockedPipelineStep(lastOutcome, result.context);
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

  // Branch Blocking Observability: the rich, standalone rendering
  // formatPipelineResult() reaches for whenever the terminal step outcome is
  // "blocked" -- repository, current/default branch, the reason, the
  // recommendation, and when the decision was made, all in one place.
  // context.generatedAt is when PipelineContext's RepositorySnapshot was
  // fetched (ExecutionPipeline.buildContext()), which is the exact instant
  // the branch state below was read -- reusing it here means this timestamp
  // can never disagree with the branch values shown next to it.
  private formatBlockedPipelineStep(outcome: Extract<PipelineStepOutcome, { status: "blocked" }>, context: PipelineContext): string {
    const { repository, branch } = context.repository;
    return this.template("⛔", this.humanizeCapability(outcome.capability), [
      this.field("Repository", this.code(repository.name)),
      "",
      this.field("Current Branch", this.code(branch.current)),
      this.field("Default Branch", this.code(branch.default)),
      "",
      this.field("Decision", this.escapeHtml(outcome.explanation)),
      "",
      this.field("Recommendation", this.escapeHtml(outcome.recommendedAction)),
      "",
      this.field("Decision Time (UTC)", this.formatAbsoluteTimestamp(context.generatedAt)),
    ]);
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
    return this.template("📦", "Artifacts", [...lines, "", suffix, "Use /artifact get &lt;id&gt; to download."]);
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
      `${list.total} ${matchWord}. Use /artifact get &lt;id&gt; to download.`,
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

  formatArtifactDeleteResult(result: ArtifactDeletionResult): string {
    if (
      result.deletedIds.length === 0 &&
      result.notFoundIds.length === 0 &&
      result.skippedIds.length === 0 &&
      result.failedIds.length === 0
    ) {
      return "Nothing to delete.";
    }

    const lines: string[] = [];
    this.pushDeletionSection(lines, "Deleted", result.deletedIds);
    this.pushDeletionSection(lines, "Not found", result.notFoundIds);
    this.pushDeletionSection(lines, "Skipped (duplicate)", result.skippedIds);
    this.pushDeletionSection(lines, "Failed", result.failedIds);

    const icon = result.failedIds.length > 0 ? "⚠️" : "🗑️";
    return this.template(icon, "Artifacts Deleted", lines);
  }

  private pushDeletionSection(lines: string[], title: string, ids: string[]): void {
    if (ids.length === 0) {
      return;
    }
    if (lines.length > 0) {
      lines.push("");
    }
    lines.push(`${title} (${ids.length}):`, ...this.truncateBulletList(ids.map((id) => this.code(id))));
  }

  formatArtifactDeleteAllConfirmation(total: number): string {
    if (total === 0) {
      return "No artifacts stored -- nothing to delete.";
    }
    return this.template("⚠️", "Confirm Delete All", [
      `This will permanently delete all ${total} artifact${total === 1 ? "" : "s"}. This cannot be undone.`,
      "",
      `Resend as ${this.code("/artifact delete-all confirm")} to proceed.`,
    ]);
  }

  formatArtifactDeleteAllResult(result: { totalDeleted: number; totalRemaining: number; elapsedMs: number }): string {
    return this.template("🗑️", "All Artifacts Deleted", [
      this.field("Deleted", String(result.totalDeleted)),
      this.field("Remaining", String(result.totalRemaining)),
      this.field("Elapsed", `${result.elapsedMs}ms`),
    ]);
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
    return this.formatAbsoluteTimestamp(date);
  }

  // Extracted from formatTimestamp's own old-date fallback -- Git History &
  // Inspection System's /show wants both this and the relative form as
  // separate, explicit fields, unlike every other caller of formatTimestamp,
  // which only ever wants one or the other.
  private formatAbsoluteTimestamp(date: Date): string {
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
    return ["", this.bold("📎 Artifacts"), ...this.truncateBulletList(items), "Use /artifact get &lt;id&gt; to download."];
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
