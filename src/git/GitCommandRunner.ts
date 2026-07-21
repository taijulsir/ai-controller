import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitCommandError } from "./errors";
import { GIT_BINARY } from "./GitConstants";

const execFileAsync = promisify(execFile);

export interface GitCommandRunnerOptions {
  dryRun?: boolean;
}

export class GitCommandRunner {
  // dryRun is unused today; it exists so a future dry-run mode only needs to
  // change the body of run(), not the constructor or call sites.
  constructor(private readonly options: GitCommandRunnerOptions = {}) {}

  // env is an additive override merged over process.env -- used only by the
  // undo snapshot mechanism to point add/write-tree at a throwaway
  // GIT_INDEX_FILE instead of the repository's real index. Every other
  // caller omits it and gets today's exact behavior.
  async run(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    try {
      const { stdout } = await execFileAsync(GIT_BINARY, args, { cwd, env: env ? { ...process.env, ...env } : undefined });
      return stdout.trim();
    } catch (error) {
      throw new GitCommandError(args, error);
    }
  }
}
