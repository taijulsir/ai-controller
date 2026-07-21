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
