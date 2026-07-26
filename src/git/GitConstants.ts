export const GIT_BINARY = "git";

export const DEFAULT_RECENT_COMMITS_LIMIT = 5;

// Git History & Inspection System (/history): distinct from
// DEFAULT_RECENT_COMMITS_LIMIT above, which backs the unrelated /status
// summary -- these two commands are allowed to default differently.
export const DEFAULT_HISTORY_LIMIT = 10;
export const MAX_HISTORY_LIMIT = 50;

// Fields are joined with \x1f (unit separator) and each record terminated with \x1e
// (record separator) so commit subjects containing spaces/punctuation can never be
// mistaken for a field boundary — see GitLogParser.ts.
const RECENT_COMMITS_FORMAT = "%H\x1f%h\x1f%an\x1f%aI\x1f%s\x1e";

// Git History & Inspection System: single-commit metadata format (git log -1
// <hash>), used by /show and /diff's own header. Adds author email and
// abbreviated parent hashes (%p) to RECENT_COMMITS_FORMAT's fields -- neither
// is needed by the multi-commit list view above, so this stays a distinct
// format rather than widening that one for every entry of a list. Always
// exactly one record (git log -1), so no trailing \x1e is needed.
const SHOW_COMMIT_FORMAT = "%H\x1f%h\x1f%an\x1f%ae\x1f%aI\x1f%p\x1f%s";

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

  // Git Health Service primitives (Phase 0 freeze, foundation layer) -- every
  // one below is read-only, matching GitAdapter's existing "mechanism, never
  // judgment" contract exactly like the commands above it.
  headSha: (): string[] => ["rev-parse", "HEAD"],
  gitDir: (): string[] => ["rev-parse", "--git-dir"],
  hasUpstreamConfigured: (branch: string): string[] => ["config", "--get", `branch.${branch}.merge`],
  upstreamRef: (): string[] => ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
  stashList: (): string[] => ["stash", "list"],
  worktreeList: (): string[] => ["worktree", "list", "--porcelain"],
  submoduleStatus: (): string[] => ["submodule", "status"],
  isShallowRepository: (): string[] => ["rev-parse", "--is-shallow-repository"],
  rebaseOnto: (ontoRef: string): string[] => ["rebase", ontoRef],
  abortRebase: (): string[] => ["rebase", "--abort"],
  continueRebase: (): string[] => ["rebase", "--continue"],
  abortCherryPick: (): string[] => ["cherry-pick", "--abort"],
  abortRevert: (): string[] => ["revert", "--abort"],
  fsck: (): string[] => ["fsck", "--no-dangling"],
  cleanForce: (): string[] => ["clean", "-fd"],
  resetHard: (ref: string): string[] => ["reset", "--hard", ref],
  resetSoft: (ref: string): string[] => ["reset", "--soft", ref],
  deleteBranch: (branch: string): string[] => ["branch", "-D", branch],
  forcePushWithLease: (): string[] => ["push", "--force-with-lease"],
  revertCommit: (ref: string): string[] => ["revert", "--no-edit", ref],
  // Directly lists only unmerged (conflicted) paths -- simpler and more
  // reliable than re-deriving them from full `status --porcelain=v2` output
  // (which GitStatusParser already buckets into staged/unstaged without
  // preserving a distinct "unmerged" list).
  listConflictedFiles: (): string[] => ["diff", "--name-only", "--diff-filter=U"],
  // --numstat reports "-\t-\t<path>" for a binary file (both counts are "-")
  // and real numeric add/delete counts for a text file -- the standard,
  // reliable way to tell them apart without guessing from a file extension.
  conflictedFilesNumstat: (): string[] => ["diff", "--numstat", "--diff-filter=U"],
  // --no-edit accepts git's own auto-generated merge message non-interactively
  // -- required after resolving a conflict, since a plain `commit` with no
  // message would otherwise try to open an editor and hang.
  commitNoEdit: (): string[] => ["commit", "--no-edit"],
  countCommitsBetween: (from: string, to: string): string[] => ["rev-list", "--count", `${from}..${to}`],
  bisectReset: (): string[] => ["bisect", "reset"],

  // Git History & Inspection System (/history branch:/author:/search:) --
  // author/search are omitted entirely rather than passed as "" when unset,
  // since git's own --author=""/--grep="" match every commit (an empty
  // pattern), not none -- the opposite of "no filter" this command needs
  // when the caller simply didn't ask for one.
  filteredHistory: (limit: number, ref?: string, author?: string, search?: string): string[] => {
    const args = ["log", "-n", String(limit), `--pretty=tformat:${RECENT_COMMITS_FORMAT}`];
    if (author) args.push(`--author=${author}`);
    if (search) args.push(`--grep=${search}`, "-i");
    if (ref) args.push(ref);
    return args;
  },
  // /show, /diff's own header -- see SHOW_COMMIT_FORMAT above.
  showCommitMeta: (hash: string): string[] => ["log", "-1", `--pretty=tformat:${SHOW_COMMIT_FORMAT}`, hash],
  // diff-tree (not `git show`) so a root commit (--root) is handled the same
  // way as any other -- compared against the empty tree, every path reported
  // "added" -- rather than diff-tree's own default of reporting nothing at
  // all for a commit with no parent. -r recurses into subdirectories, same
  // as diffNameStatus above; --no-renames for the same reason diffNameStatus
  // has it (a rename must never silently hide as a single "R" record this
  // codebase's status mapping doesn't understand).
  nameStatusForCommit: (hash: string): string[] => [
    "diff-tree",
    "--no-commit-id",
    "--no-renames",
    "--name-status",
    "-r",
    "--root",
    hash,
  ],
  // Same shape as nameStatusForCommit above, --numstat instead of
  // --name-status -- per-file insertion/deletion counts for the same commit,
  // parsed separately since numstat alone can't distinguish "added" from "a
  // modified file with zero deletions" (see GitHistoryService's own doc
  // comment on why both commands are needed).
  numstatForCommit: (hash: string): string[] => ["diff-tree", "--no-commit-id", "--no-renames", "--numstat", "-r", "--root", hash],

  // Working Tree Management (/changes, /showchanges, /discard <index>,
  // /discard all) -- reuses status() verbatim (same command, a second,
  // richer parse of the identical output -- see GitStatusParser.
  // parseWorkingTreeChanges) for listing, and adds four small, purpose-built
  // primitives for showing/discarding one file's change at a time. None of
  // these is reset --hard: per-file discard is always expressed as restore
  // (index+worktree back to HEAD) or clean (remove an untracked path), the
  // two git subcommands built specifically for "make this path match a known
  // good state" without moving HEAD, touching unrelated commits, or
  // affecting any other path.
  //
  // /showchanges <index>'s own diff commands -- three variants (unstaged,
  // staged, untracked) since a plain `git diff` needs to be told which
  // baseline to compare the working tree against, and untracked files have
  // no baseline in git at all. Deliberately WITHOUT --no-renames (unlike
  // every machine-parsed diff command elsewhere in this file, e.g.
  // diffNameStatus) -- this output is only ever shown to a human, never
  // parsed, so git's own rename detection is left on: for a renamed file
  // (both old and new path passed as pathspecs by GitAdapter.
  // getWorkingTreeChangeDiff) that produces a real "rename from/rename to"
  // diff with just the content delta, not a confusing whole-file
  // delete+add pair.
  diffWorkingTree: (paths: string[]): string[] => ["diff", "--", ...paths],
  diffStaged: (paths: string[]): string[] => ["diff", "--cached", "--", ...paths],
  // --no-index compares two real paths directly, bypassing the index
  // entirely -- the only way to get a real, familiar-looking unified diff
  // for a file git has no record of at all. Exits 1 whenever the two sides
  // differ (always true here, since /dev/null is always "empty") -- a normal
  // outcome, not a failure; see GitAdapter.getWorkingTreeChangeDiff's own
  // handling, the same exit-code-1-is-not-an-error pattern isAncestor()
  // already established for merge-base --is-ancestor.
  diffUntrackedAgainstEmpty: (path: string): string[] => ["diff", "--no-renames", "--no-index", "--", "/dev/null", path],
  // /discard's own restore/unstage/remove primitives -- deliberately three
  // narrow commands, not one, so WorkingTreeService (which decides which
  // applies per file, based on that file's own status) never has to build a
  // single command flexible enough to cover every case at once, the same
  // "GitAdapter stays mechanism, the caller stays judgment" split every
  // other primitive in this file already follows.
  //
  // --source=HEAD --staged --worktree together reset *both* the index and
  // the working tree copy of each path back to HEAD in one atomic command --
  // correct for modified/deleted paths and for a rename's own old path
  // (which always exists in HEAD), regardless of whether the path is
  // currently staged, unstaged, or both; --staged is a safe no-op when
  // nothing is actually staged for that path.
  restoreFromHead: (paths: string[]): string[] => ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...paths],
  // For a path that does NOT exist in HEAD (a staged-added file, or a
  // rename's own new path) -- restore --staged with no --source defaults to
  // unstaging against HEAD, which git handles correctly even when the path
  // itself has no HEAD counterpart (the whole point of unstaging a new file
  // is to make it not-staged, not to restore content that was never there).
  unstagePaths: (paths: string[]): string[] => ["restore", "--staged", "--", ...paths],
  // -fd (not -fdx/-fdX): only ever removes genuinely untracked, non-ignored
  // paths -- git clean's own default behavior already guarantees an ignored
  // file is never touched, so no separate check is needed here to satisfy
  // "never delete ignored files unexpectedly". -d so an entirely untracked
  // directory (reported as one line by `git status`) is removed as a whole,
  // not left as an empty shell. Always path-scoped (`--` + explicit paths),
  // never the bare whole-tree `cleanForce()` above -- the one thing that
  // makes single-file discard safe to distinguish from /discard's own
  // intentionally-whole-tree cleanForce() call.
  removeUntrackedPaths: (paths: string[]): string[] => ["clean", "-fd", "--", ...paths],
} as const;
