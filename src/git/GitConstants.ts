export const GIT_BINARY = "git";

export const DEFAULT_RECENT_COMMITS_LIMIT = 5;

// Fields are joined with \x1f (unit separator) and each record terminated with \x1e
// (record separator) so commit subjects containing spaces/punctuation can never be
// mistaken for a field boundary — see GitLogParser.ts.
const RECENT_COMMITS_FORMAT = "%H\x1f%h\x1f%an\x1f%aI\x1f%s\x1e";

export const GitCommand = {
  status: (): string[] => ["status", "--porcelain=v2", "--branch"],
  currentBranch: (): string[] => ["rev-parse", "--abbrev-ref", "HEAD"],
  // --format=%(refname:short) yields one bare local branch name per line —
  // no "* " current-branch marker, no indentation to strip, unlike plain
  // `git branch`. Local only (no -a/-r), matching this command's scope.
  listBranches: (): string[] => ["branch", "--format=%(refname:short)"],
  checkout: (branch: string): string[] => ["checkout", branch],
  createBranch: (branch: string): string[] => ["checkout", "-b", branch],
  stageAll: (): string[] => ["add", "-A"],
  commit: (message: string): string[] => ["commit", "-m", message],
  push: (): string[] => ["push", "--set-upstream", "origin", "HEAD"],
  recentCommits: (limit: number): string[] => ["log", "-n", String(limit), `--pretty=tformat:${RECENT_COMMITS_FORMAT}`],
  // The undo snapshot mechanism (GitAdapter.createSnapshot): addAll/writeTree
  // are always run together against a throwaway GIT_INDEX_FILE, never the
  // repository's real index -- see GitAdapter's own doc comment for why
  // (plain `git stash create` cannot see untracked files and fails outright
  // on a repository with zero commits; this pair of plumbing commands has
  // neither limitation).
  addAll: (): string[] => ["add", "-A"],
  writeTree: (): string[] => ["write-tree"],
  // Always two trees, never one tree implicitly "vs the working tree" --
  // verified empirically that plain `git diff <tree>` (one argument) only
  // compares *tracked* paths against that tree; an untracked file present on
  // disk is reported as deleted regardless of its real content, since plain
  // diff never scans the filesystem for untracked matches. Every "compare
  // against the current live state" call in this codebase must first take a
  // fresh createSnapshot() and diff that tree against the other one instead
  // -- see GitAdapter.diffChangedFiles's own doc comment.
  //
  // --no-renames is mandatory here, not a style choice: without it, whether a
  // path shows up as "R100 old new" instead of independent "D old"/"A new"
  // lines depends on the running user's own global diff.renames config,
  // which this process does not control. GitAdapter.diffChangedFiles() is
  // written assuming every line is exactly one of A/M/D -- forcing renames
  // off keeps that assumption true regardless of environment.
  diffNameStatus: (from: string, to: string): string[] => ["diff", "--no-renames", "--name-status", from, to],
  // Same two-trees precondition as diffNameStatus above, minus --name-status
  // -- the full unified patch instead of just the file list.
  diff: (from: string, to: string): string[] => ["diff", "--no-renames", from, to],
  // Reads one path's blob content as it existed at treeish, via git's own
  // "<tree>:<path>" object syntax -- never touches the working tree or index.
  showFile: (treeish: string, filePath: string): string[] => ["show", `${treeish}:${filePath}`],
  // --source=<treeish> restores the *working tree* copy of each pathspec from
  // that snapshot -- never touches HEAD or the current branch, since a
  // pathspec (the "--" and everything after it) is present. Callers only
  // ever invoke this for paths already known (via diffNameStatus) to exist in
  // fromTreeish; a path that doesn't exist there must be deleted directly by
  // the caller instead (git restore has no "remove this path" mode).
  restorePaths: (fromTreeish: string, paths: string[]): string[] => ["restore", `--source=${fromTreeish}`, "--", ...paths],
  // Phase D (Git Operations): updates remote-tracking refs (e.g. origin/main)
  // only -- never touches the working tree, the index, or the current
  // branch, so no safety precondition is needed to run this.
  fetch: (): string[] => ["fetch"],
  // Plumbing check, not a mutation: exits 0 when `ancestor` is reachable
  // from `ref` (i.e. fast-forwarding from ancestor to ref is possible),
  // exits 1 when it is not -- both are normal, meaningful outcomes, not
  // failures. GitAdapter.isAncestor() is the only caller, and is the only
  // place that distinguishes exit code 1 (a plain "no") from any other
  // exit code (a genuine error, e.g. an unknown ref).
  isAncestor: (ancestor: string, ref: string): string[] => ["merge-base", "--is-ancestor", ancestor, ref],
  // Only ever invoked after isAncestor has already confirmed a fast-forward
  // is possible, so this should never actually fail in normal operation --
  // --ff-only is still specified so it can never silently fall back to
  // creating a merge commit if that assumption were ever wrong.
  fastForwardMerge: (ref: string): string[] => ["merge", "--ff-only", ref],
  // Only ever invoked after isAncestor has already confirmed a fast-forward
  // is NOT possible -- always produces either a real merge commit or a
  // conflict, never silently fast-forwards instead (moot at that point, but
  // --no-ff makes the intent explicit rather than relying on ff simply not
  // being available).
  merge: (ref: string): string[] => ["merge", "--no-ff", ref],
  // The one recovery path for a conflicted merge -- restores HEAD, the
  // index, and the working tree to exactly their pre-merge state. Reused
  // as-is rather than reimplemented via the undo snapshot mechanism (Phase
  // B), which solves a different problem (restoring uncommitted Claude
  // edits) -- this is git's own correct, atomic tool for an in-progress
  // merge specifically.
  abortMerge: (): string[] => ["merge", "--abort"],
} as const;
