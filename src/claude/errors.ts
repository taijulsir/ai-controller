export class NoActiveRepositoryError extends Error {
  constructor() {
    super(
      "No active repository is set. Call setActiveRepository() on the registry first, or construct the adapter with an explicit repository id.",
    );
    this.name = "NoActiveRepositoryError";
  }
}

export class ClaudeAlreadyRunningError extends Error {
  constructor() {
    super(
      "A Claude process is already running. Call stopSession() or wait for it to finish before starting another.",
    );
    this.name = "ClaudeAlreadyRunningError";
  }
}

export class ClaudeCommandError extends Error {
  constructor(args: string[], exitCode: number | null, stderr: string) {
    const exitCodeSuffix = exitCode !== null ? ` (exit code ${exitCode})` : "";
    super(`claude ${args.join(" ")} failed${exitCodeSuffix}: ${stderr.trim() || "no error output"}`);
    this.name = "ClaudeCommandError";
  }
}

export class ClaudeExecutionTimeoutError extends Error {
  constructor(timeoutMinutes: number) {
    super(`Claude execution exceeded the configured timeout of ${timeoutMinutes} minute(s) and was terminated.`);
    this.name = "ClaudeExecutionTimeoutError";
  }
}
