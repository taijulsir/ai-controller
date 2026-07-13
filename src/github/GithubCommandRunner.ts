import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GithubCommandError } from "./errors";

const execFileAsync = promisify(execFile);

export class GithubCommandRunner {
  async run(executable: string, cwd: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync(executable, args, { cwd });
      return stdout.trim();
    } catch (error) {
      throw new GithubCommandError(executable, args, error);
    }
  }
}
