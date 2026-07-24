import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitCommandError } from "./errors";
import { GIT_BINARY } from "./GitConstants";

const execFileAsync = promisify(execFile);

// Telegram bot uploads cap at 50MB -- matched here so a large-but-legitimate
// tracked file (an image, a bundled binary) never hits Node's default 1MB
// child_process stdout limit before it can even become an artifact.
const MAX_FILE_CONTENT_BYTES = 50 * 1024 * 1024;

export interface GitCommandRunnerOptions {
  dryRun?: boolean;
}

export class GitCommandRunner {
  // dryRun is unused today; it exists so a future dry-run mode only needs to
  // change the body of run(), not the constructor or body.
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

  // Binary-safe: stdout is captured as raw bytes, never decoded as UTF-8.
  // GitAdapter.readFile is the one caller -- forcing a blob's content (which
  // may be an image, a compiled binary, anything) through UTF-8 decoding
  // would silently corrupt any byte sequence that isn't valid UTF-8 (verified
  // empirically: invalid sequences are replaced with U+FFFD, changing both
  // the byte length and content, non-reversibly).
  async runBinary(cwd: string, args: string[]): Promise<Buffer> {
    try {
      const { stdout } = await execFileAsync(GIT_BINARY, args, { cwd, encoding: "buffer", maxBuffer: MAX_FILE_CONTENT_BYTES });
      return stdout;
    } catch (error) {
      throw new GitCommandError(args, error);
    }
  }
}
