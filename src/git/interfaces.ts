import type {
  CommitDetail,
  CommitDiffStat,
  CommitDiffStatResult,
  CommitMetadata,
  CommitSummary,
  GitFileChange,
  GitHistoryFilter,
  GitHistoryResult,
  GitStatus,
  RepositoryHealthReport,
  SubmoduleStatus,
  WorktreeInfo,
} from "./types";

export interface IGitAdapter {
  status(): Promise<GitStatus>;
  currentBranch(): Promise<string>;
  listBranches(): Promise<string[]>;
  checkout(branch: string): Promise<void>;
  createBranch(branch: string): Promise<void>;
  stageAll(): Promise<void>;
  commit(message: string): Promise<void>;
  push(): Promise<void>;
  getRecentCommits(limit?: number): Promise<CommitSummary[]>;
  // Undo checkpoint mechanism (Phase B): all three are pure git-plumbing
  // additions, no different in kind from the ten methods above -- GitAdapter
  // remains the one and only thing that talks to git.
  //
  // Captures a tree-ish representing the *entire current working tree*
  // (tracked, modified, and untracked files alike, respecting .gitignore) at
  // this exact instant, without staging anything into the repository's real
  // index and without requiring any prior commit to exist. Returns a tree
  // SHA usable directly with diffChangedFiles()/restorePaths() below -- never
  // wrapped in a commit, since neither of those needs one.
  createSnapshot(): Promise<string>;
  // Compares two tree-ish snapshots and reports every path that differs.
  // Both arguments are always required, deliberately: comparing a tree
  // against the *current live state* means taking a fresh createSnapshot()
  // first and diffing that tree here, never asking git to diff a tree
  // against "the working tree" implicitly -- verified empirically that
  // plain `git diff <tree>` (no second tree) only compares tracked paths,
  // silently reporting an untracked-but-unchanged file as deleted. Diffing
  // two trees produced by createSnapshot() avoids that blind spot entirely,
  // since both sides already correctly include untracked files.
  diffChangedFiles(from: string, to: string): Promise<GitFileChange[]>;
  // Restores filesToRestore's working-tree content from fromTreeish, and
  // deletes filesToDelete outright (paths that don't exist in fromTreeish at
  // all -- restoring "to" a snapshot where they never existed means removing
  // them, which no git restore/checkout invocation can express by itself).
  // Never moves HEAD or touches the current branch either way.
  restorePaths(fromTreeish: string, filesToRestore: string[], filesToDelete: string[]): Promise<void>;

  // Phase D (Git Operations): five more purely mechanical primitives --
  // GitAdapter still never makes a safety decision itself (never checks
  // cleanliness, detached HEAD, or divergence); FetchWorkflow/SyncWorkflow/
  // MergeWorkflow own those decisions, the same separation
  // SwitchBranchWorkflow already established for its own dirty-tree check.
  fetch(): Promise<void>;
  // True when `ancestor` is reachable from `ref` -- i.e. fast-forwarding
  // from `ancestor` to `ref` is possible. Callers pass "HEAD" or "@{upstream}"
  // as either argument; git resolves both.
  isAncestor(ancestor: string, ref: string): Promise<boolean>;
  // Only safe to call once isAncestor has already confirmed it's possible.
  fastForward(ref: string): Promise<void>;
  // Only safe to call once isAncestor has already confirmed a fast-forward
  // is NOT possible. May throw on conflict -- callers must call abortMerge()
  // in that case, this method never does so itself.
  mergeBranch(ref: string): Promise<void>;
  abortMerge(): Promise<void>;

  // Artifact Management (fix-diff artifacts): unlike diffChangedFiles above,
  // this returns the full unified patch text, not just path+status -- the
  // one place this codebase renders a human-readable diff rather than acting
  // on a machine-readable file list.
  diff(from: string, to: string): Promise<string>;
  // Reads one file's content as it existed at a given tree-ish (e.g. an undo
  // checkpoint's beforeSnapshot/afterSnapshot). Callers must only pass a path
  // already known (via diffChangedFiles) to exist in treeish -- same
  // precondition restorePaths() already documents for its own pathspec.
  // Returns raw bytes, not a string -- a blob may be binary (image, compiled
  // artifact, anything), and decoding it as text would silently corrupt any
  // byte sequence that isn't valid UTF-8.
  readFile(treeish: string, filePath: string): Promise<Buffer>;

  // Phase 0 freeze -- Git Health Service primitives. Every one is read-only
  // (or, below the "mutating primitives" comment, mechanical and
  // judgment-free the same way createBranch()/checkout() already are);
  // GitAdapter still never decides whether an operation is safe -- that
  // stays with Pre-flight Validation / the calling Engine.
  headSha(): Promise<string>;
  // Absolute path to the real git directory -- resolves worktrees/submodules
  // correctly, never assumes ".git" is a plain directory under the repo root.
  gitDir(): Promise<string>;
  hasUpstreamConfigured(branch: string): Promise<boolean>;
  // undefined when no upstream is configured, or it's configured but no
  // longer resolves (its remote branch was deleted).
  upstreamRef(): Promise<string | undefined>;
  stashCount(): Promise<number>;
  listWorktrees(): Promise<WorktreeInfo[]>;
  listSubmodules(): Promise<SubmoduleStatus[]>;
  isShallowRepository(): Promise<boolean>;
  // true when `git fsck` reported no errors.
  fsck(): Promise<{ clean: boolean; output: string }>;

  // Mutating primitives -- each backs exactly one Engine/Framework operation
  // named in the approved review; still purely mechanical, no precondition
  // checks of their own.
  rebase(ontoRef: string): Promise<void>;
  abortRebase(): Promise<void>;
  continueRebase(): Promise<void>;
  abortCherryPick(): Promise<void>;
  abortRevert(): Promise<void>;
  abortBisect(): Promise<void>;
  cleanWorkingTree(): Promise<void>;
  resetHard(ref: string): Promise<void>;
  resetSoft(ref: string): Promise<void>;
  deleteBranch(branch: string): Promise<void>;
  forcePushWithLease(): Promise<void>;
  revertCommit(ref: string): Promise<void>;

  commitNoEdit(): Promise<void>;
  countCommitsBetween(from: string, to: string): Promise<number>;
  listConflictedFiles(): Promise<string[]>;
  // Path -> true when the conflicted blob is binary (see GitConstants'
  // conflictedFilesNumstat doc comment for the detection method).
  conflictedFilesAreBinary(): Promise<Map<string, boolean>>;

  // Git History & Inspection System: read-only, mechanical primitives, no
  // different in kind from getRecentCommits above -- GitAdapter still never
  // decides what's "interesting" or translates a git failure into a
  // friendly message (that's GitHistoryService's job, the same
  // mechanism/policy split GitHealthService already established).
  getCommitHistory(limit: number, ref?: string, author?: string, search?: string): Promise<CommitSummary[]>;
  getCommitMetadata(hash: string): Promise<CommitMetadata>;
  getCommitFileChanges(hash: string): Promise<GitFileChange[]>;
  getCommitDiffStat(hash: string): Promise<CommitDiffStat[]>;
}

export interface IGitHealthService {
  getHealth(repositoryId?: string): Promise<RepositoryHealthReport>;
}

// Deviation from the Phase 0 freeze, noted in the implementation report:
// diff()/restore() gained a repositoryId parameter capture() already had --
// omitting it there was an oversight (this service, like every other
// Foundation component, is one shared instance across every repository, not
// one instance per repository), not an intentional design choice worth
// preserving verbatim.
export interface IRepositorySnapshotService {
  capture(repositoryId: string): Promise<string>;
  diff(repositoryId: string, fromRef: string, toRef: string): Promise<GitFileChange[]>;
  restore(repositoryId: string, fromRef: string, filesToRestore: string[], filesToDelete: string[]): Promise<void>;
}

// Git History & Inspection System: the Foundation-layer composer for
// /history, /show, /diff -- same role GitHealthService plays for /health,
// composing GitAdapter's mechanical primitives into ready-to-format results
// and translating a raw GitCommandError into a specific, friendly domain
// error (CommitNotFoundError, BranchNotFoundError) instead of letting git's
// own stderr reach the user.
export interface IGitHistoryService {
  getHistory(repositoryId: string, filter: GitHistoryFilter): Promise<GitHistoryResult>;
  getCommitDetail(repositoryId: string, hash: string): Promise<CommitDetail>;
  getCommitDiffStat(repositoryId: string, hash: string): Promise<CommitDiffStatResult>;
}
