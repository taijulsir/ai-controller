function isExecFileError(value: unknown): value is { code?: number; stderr?: string } {
  return typeof value === "object" && value !== null && "stderr" in value;
}

export class GithubCommandError extends Error {
  constructor(executable: string, args: string[], cause: unknown) {
    const details = isExecFileError(cause) ? cause : undefined;
    const stderr = details?.stderr?.trim();
    const exitCodeSuffix = details?.code !== undefined ? ` (exit code ${details.code})` : "";
    const reason = stderr || (cause instanceof Error ? cause.message : String(cause));

    super(`${executable} ${args.join(" ")} failed${exitCodeSuffix}: ${reason}`);
    this.name = "GithubCommandError";
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
