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
