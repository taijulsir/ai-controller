function isExecFileError(value: unknown): value is { code?: number; stderr?: string } {
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

  constructor(args: string[], cause: unknown) {
    const details = isExecFileError(cause) ? cause : undefined;
    const stderr = details?.stderr?.trim();
    const exitCodeSuffix = details?.code !== undefined ? ` (exit code ${details.code})` : "";
    const reason = stderr || (cause instanceof Error ? cause.message : String(cause));

    super(`git ${args.join(" ")} failed${exitCodeSuffix}: ${reason}`);
    this.name = "GitCommandError";
    this.exitCode = details?.code;
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
