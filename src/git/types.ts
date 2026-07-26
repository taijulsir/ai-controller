export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  isClean: boolean;
}

export interface CommitSummary {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: Date;
}

// One path's change between two tree-ish snapshots (see GitAdapter.diffChangedFiles).
// "added" means the path did not exist in the "from" snapshot at all -- restoring it
// means deleting it, not checking it out. --no-renames is always passed when this is
// produced, so a rename is deliberately reported as an independent "deleted" (old
// path) + "added" (new path) pair, never a rename record -- correct and simpler to
// restore than relying on git's own (sometimes ambiguous) rename heuristics.
export interface GitFileChange {
  path: string;
  status: "added" | "modified" | "deleted";
}

// ---------------------------------------------------------------------------
// Repository Health Model (Phase 0 freeze, §9) -- additive to GitStatus
// above, never a replacement. GitStatus stays exactly as every existing
// consumer (RepositoryIntelligenceService, DecisionEngine, StrategyEngine,
// RecommendationEngine) already reads it; RepositoryHealthReport is the new,
// richer superset Git Health Service produces.
// ---------------------------------------------------------------------------

export interface RepositoryHealthReport {
  repositoryId: string;
  capturedAt: Date;

  branch: string;
  detachedHead: boolean;
  headSha: string;

  // undefined when no upstream is configured at all
  upstream: UpstreamStatus | undefined;

  staged: string[];
  unstaged: string[];
  untracked: string[];
  isClean: boolean;

  inProgressOperation: InProgressOperation | undefined;

  stashCount: number;

  // undefined when the GitHub adapter can't reach the API, or branch
  // protection detection is not configured for this deployment.
  branchProtection: BranchProtectionStatus | undefined;

  locks: GitLockStatus;

  worktrees: WorktreeInfo[];
  submodules: SubmoduleStatus[];
  isShallow: boolean;
  lfs: LfsStatus | undefined;

  interruptedOperation: InterruptedOperationInfo | undefined;

  // Known limitation (see implementation report): always false today --
  // detecting these requires persisting the previous remote-tracking SHA
  // across calls, which no component in this phase does yet. Never a false
  // positive; may under-report.
  forcePushDetected: boolean;
  remoteChangedSinceLastFetch: boolean;
}

export interface UpstreamStatus {
  ref: string;
  ahead: number;
  behind: number;
  diverged: boolean;
  deleted: boolean;
}

export enum InProgressOperationKind {
  Merge = "merge",
  Rebase = "rebase",
  CherryPick = "cherry-pick",
  Revert = "revert",
  Bisect = "bisect",
}

export interface InProgressOperation {
  kind: InProgressOperationKind;
  detail?: RebaseProgress;
}

export interface RebaseProgress {
  currentStep: number;
  totalSteps: number;
  conflicted: boolean;
}

export interface BranchProtectionStatus {
  protected: boolean;
  requiresPullRequest: boolean;
  requiresStatusChecks: boolean;
  allowsForcePush: boolean;
}

export interface GitLockStatus {
  indexLocked: boolean;
  headLocked: boolean;
  // Lock present but old enough (mtime-based heuristic, see
  // GitHealthService) that no process is plausibly still holding it.
  staleLockDetected: boolean;
}

export interface WorktreeInfo {
  path: string;
  branch: string | undefined;
  isCurrent: boolean;
}

export interface SubmoduleStatus {
  path: string;
  isDirty: boolean;
  isDetached: boolean;
  initialized: boolean;
}

export interface LfsStatus {
  enabled: boolean;
  cliAvailable: boolean;
  pendingUploads: number;
  pendingDownloads: number;
}

export interface InterruptedOperationInfo {
  kind: InProgressOperationKind;
  journalEntryId: string | undefined;
}

// ---------------------------------------------------------------------------
// Git History & Inspection System -- additive to CommitSummary above, never a
// replacement. CommitSummary stays exactly as its existing consumer
// (RepositoryIntelligenceService, via GitAdapter.getRecentCommits) already
// reads it; the types below back the new /history, /show, /diff commands.
// ---------------------------------------------------------------------------

// Raw per-commit metadata for a single, specifically-addressed commit (git
// log -1 <hash>) -- richer than CommitSummary (adds email + parents), kept
// as its own type rather than widening CommitSummary itself, since no
// existing CommitSummary consumer needs either field and parsing them for
// every entry of a multi-commit list would be pure waste.
export interface CommitMetadata {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  authorDate: Date;
  // Short hashes, root commits have zero.
  parents: string[];
  subject: string;
}

// One file's insertion/deletion counts within a single commit (git diff-tree
// --numstat). "binary" mirrors conflictedFilesAreBinary()'s own numstat
// sentinel check ("-"/"-" for both counts) -- true insertions/deletions are
// meaningless for a binary file, so both counts are always 0 when this is set.
export interface CommitDiffStat {
  path: string;
  insertions: number;
  deletions: number;
  binary: boolean;
}

export interface GitHistoryFilter {
  limit?: number;
  branch?: string;
  author?: string;
  search?: string;
}

// currentBranch/headSha/detachedHead ride along with the commit list itself
// so a caller can mark "this is the branch tip" per commit without a second
// round trip -- same "bundle what the caller needs to render, in one
// result" shape RepositoryHealthReport already uses. repositoryId is the
// resolved id (never undefined, even when the caller omitted one and it
// fell back to the active repository) -- Telegram's inline "Show"/"Diff"/
// "Undo" buttons encode it in their own callback_data so a later tap always
// targets the repository /history was actually run against, regardless of
// whatever is active by the time the button is pressed.
export interface GitHistoryResult {
  repositoryId: string;
  commits: CommitSummary[];
  currentBranch: string;
  headSha: string;
  detachedHead: boolean;
}

// Everything /show <hash> needs in one composed result: CommitMetadata plus
// the per-file change list and aggregate stat totals, the same "Foundation
// primitives composed into one report" role GitHealthService already plays
// for RepositoryHealthReport.
export interface CommitDetail extends CommitMetadata {
  isHead: boolean;
  // Set only when isHead is true and HEAD is not detached.
  currentBranch: string | undefined;
  files: GitFileChange[];
  filesChanged: number;
  insertions: number;
  deletions: number;
}

// /diff <hash>'s own result: the per-file breakdown plus the same aggregate
// totals CommitDetail carries, computed from the exact same numstat data --
// never a second, independently-derived set of totals.
export interface CommitDiffStatResult {
  sha: string;
  shortSha: string;
  files: CommitDiffStat[];
  filesChanged: number;
  insertions: number;
  deletions: number;
}

// ---------------------------------------------------------------------------
// Working Tree Management (/changes, /showchanges, /discard <index>,
// /discard all) -- additive to GitStatus/GitFileChange above, never a
// replacement. GitStatus stays exactly as every existing consumer
// (RepositoryIntelligenceService, DecisionEngine, StrategyEngine,
// RecommendationEngine, GitHealthService) already reads it -- this is a
// second, richer read over the same `git status --porcelain=v2` output
// (see GitStatusParser.parseWorkingTreeChanges), needed because none of
// those existing consumers need per-file status codes or a stable index to
// address one file by, and GitStatus/parseGitStatus's existing behavior must
// never change underneath them.
// ---------------------------------------------------------------------------

export type WorkingTreeChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";

// One path's current working-tree change, addressed by a stable `index`
// (1-based, assigned once per getChanges() call in a fixed grouping order --
// see WorkingTreeService.getChanges()) -- /showchanges and /discard both
// resolve their own <index> argument against a freshly recomputed list of
// these, never a cached/remembered one, so "index 3" always means whatever
// getChanges() would show as #3 right now.
export interface WorkingTreeChange {
  index: number;
  path: string;
  status: WorkingTreeChangeStatus;
  // Whether this path has index-side (staged) and/or worktree-side
  // (unstaged) differences -- independent booleans, not mutually exclusive:
  // a file can be staged-modified and further modified since, in which case
  // both are true. "untracked" paths are neither (see staged/unstaged count
  // semantics below) -- untracked is its own bucket, matching
  // GitHealthService/RepositoryHealthReport's existing three-way
  // staged/unstaged/untracked split.
  staged: boolean;
  unstaged: boolean;
  // Only set when status === "renamed" -- the path's name before the
  // rename, needed to restore it (see WorkingTreeService.executeDiscardPlan).
  renamedFrom?: string;
}

export interface WorkingTreeChangesResult {
  repositoryId: string;
  changes: WorkingTreeChange[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  isClean: boolean;
}

// /showchanges <index>'s own result -- the resolved change plus its diff
// text. For an untracked file (no baseline to diff against) this is a
// synthetic "entire file added" diff (git diff --no-index against an empty
// file), the same shape a real diff has, just with no prior content to
// compare -- never raw file content shown unlabeled as if it were a diff.
export interface WorkingTreeChangeDiff {
  change: WorkingTreeChange;
  diff: string;
}

// /discard <index> vs. /discard all -- resolved eagerly by
// WorkingTreeService.buildDiscardPlan() against a fresh getChanges() list
// (see WorkingTreeChange's own doc comment on why "index" is never cached).
export type DiscardTarget = { kind: "index"; index: number } | { kind: "all" };

export type DiscardPlanStatus = "ready" | "nothing-to-discard" | "execution-in-progress" | "operation-in-progress";

// Same shape convention as src/undo/types.ts's UndoPlan -- a status plus
// fields that are only meaningful (non-empty) when status === "ready".
export interface DiscardPlan {
  status: DiscardPlanStatus;
  repositoryId: string;
  target: DiscardTarget;
  // The specific file(s) this plan would discard -- empty unless "ready".
  changes: WorkingTreeChange[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
}

// executeDiscardPlan()'s result -- affectedFiles is exactly plan.changes'
// paths (never re-derived), the remaining three fields are the *working
// tree's* state immediately after discarding, i.e. a fresh getChanges() call,
// so the caller can confirm the tree actually went clean (or report what's
// still left) without a second round trip.
export interface DiscardOutcome {
  kind: "discarded";
  affectedFiles: string[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  isClean: boolean;
}
