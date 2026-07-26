function isExecFileError(value: unknown): value is { code?: number; stderr?: string; stdout?: string } {
  return typeof value === "object" && value !== null && "stderr" in value;
}

export class GitCommandError extends Error {
  // Exposed so a caller can distinguish a specific, meaningful exit code
  // (e.g. `git merge-base --is-ancestor` exits 1 to mean a plain "no", not
  // an error) from a genuine failure, without parsing stderr text -- see
  // GitAdapter.isAncestor()'s own doc comment for why that matters.
  // undefined when the failure never reached a process exit at all (e.g.
  // the git binary itself couldn't be spawned).
  readonly exitCode?: number;

  // Working Tree Management: `git diff --no-index` (GitAdapter.
  // getWorkingTreeChangeDiff, the untracked-file case) always exits 1 when
  // the two sides differ -- its real, useful diff output still arrives on
  // stdout even though the process "fails" by git's own convention. Node's
  // execFile attaches the child process's captured stdout to the rejected
  // error object even on non-zero exit (verified empirically -- same
  // mechanism that already attaches stderr, which the constructor above
  // already reads); exposed here the same way exitCode is, rather than a
  // second, error-message-parsing path for this one caller. Empty string
  // (never undefined) when the failure produced no stdout at all.
  readonly stdout: string;

  constructor(args: string[], cause: unknown) {
    const details = isExecFileError(cause) ? cause : undefined;
    const stderr = details?.stderr?.trim();
    const exitCodeSuffix = details?.code !== undefined ? ` (exit code ${details.code})` : "";
    const reason = stderr || (cause instanceof Error ? cause.message : String(cause));

    super(`git ${args.join(" ")} failed${exitCodeSuffix}: ${reason}`);
    this.name = "GitCommandError";
    this.exitCode = details?.code;
    this.stdout = details?.stdout?.trim() ?? "";
  }
}

export class NoActiveRepositoryError extends Error {
  constructor() {
    super(
      "No active repository is set. Call setActiveRepository() on the registry first, or construct the adapter with an explicit repository id.",
    );
    this.name = "NoActiveRepositoryError";
  }
}

// Git History & Inspection System: thrown by GitHistoryService instead of
// letting a raw GitCommandError (git's own "fatal: bad revision" stderr)
// reach the user directly -- /show, /diff, and /undo <hash> all address a
// single commit by a user-typed reference, and this is the one clear,
// friendly message every one of them needs when it doesn't resolve.
export class CommitNotFoundError extends Error {
  constructor(reference: string) {
    super(`No commit found matching "${reference}".`);
    this.name = "CommitNotFoundError";
  }
}

// Git History & Inspection System: thrown by GitHistoryService for
// "/history branch:<name>" when <name> isn't a local branch -- checked
// proactively against listBranches() rather than left to surface as git
// log's own ambiguous "unknown revision or path" stderr.
export class BranchNotFoundError extends Error {
  constructor(branch: string) {
    super(`No local branch named "${branch}" exists.`);
    this.name = "BranchNotFoundError";
  }
}

// Working Tree Management: thrown by WorkingTreeService for "/showchanges
// <index>" or "/discard <index>" when <index> doesn't resolve against a
// freshly recomputed getChanges() list -- same "friendly domain error, not
// raw git stderr" role CommitNotFoundError/BranchNotFoundError already play
// (there is no git stderr here at all; the index is this codebase's own
// concept, not git's).
export class WorkingTreeChangeNotFoundError extends Error {
  constructor(index: number) {
    super(`No working-tree change found at index ${index}. Run /changes to see current indexes.`);
    this.name = "WorkingTreeChangeNotFoundError";
  }
}

// Working Tree Management: mirrors src/undo/errors.ts's
// CannotExecuteUndoPlanError exactly -- a programmer error (ApplicationService
// calling executeDiscardPlan() on a plan whose status isn't "ready"), never
// reachable from user input, since ApplicationService only ever calls
// executeDiscardPlan() after checking status itself.
export class CannotExecuteDiscardPlanError extends Error {
  constructor(status: string) {
    super(`executeDiscardPlan() was called with a plan whose status is "${status}", not "ready".`);
    this.name = "CannotExecuteDiscardPlanError";
  }
}
