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

  async run(cwd: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(GIT_BINARY, args, { cwd });
      return stdout.trim();
    } catch (error) {
      throw new GitCommandError(args, error);
    }
  }
}
