import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import { GIT_BINARY } from "../git";
import type { IConfigService } from "../config/interfaces";
import type { IEnvironmentValidator } from "./interfaces";
import type { EnvironmentValidationIssue, EnvironmentValidationReport } from "./types";

const execFileAsync = promisify(execFile);

// README.md's own stated requirement (built-in fetch + process.loadEnvFile).
const MINIMUM_NODE_MAJOR = 20;
const MINIMUM_NODE_MINOR = 6;

// This is the one class in src/startup/ — and the fourth in the codebase
// overall, alongside GitCommandRunner/ClaudeProcessRunner/GithubCommandRunner
// — permitted to touch child_process directly. Its job is narrowly scoped to
// a single startup-time concern (are the prerequisites this process depends
// on actually present) and is otherwise unrelated to what those three
// classes do (running real git/claude/gh operations against a repository).
//
// Every check here is advisory, deliberately: claude/gh are only required
// for specific workflows (per README.md), not universally, and gating
// startup on their absence would be a behavior change this project doesn't
// currently make — the existing precedent (see ClaudeProcessRunner's spawn
// "error" handling) is to fail a specific operation clearly when it's
// actually attempted, not to refuse to start over a prerequisite that might
// never be needed in a given deployment.
export class EnvironmentValidator implements IEnvironmentValidator {
  constructor(private readonly configService: IConfigService) {}

  async validate(): Promise<EnvironmentValidationReport> {
    const issues: EnvironmentValidationIssue[] = [];

    this.checkNodeVersion(issues);
    await this.checkCliAvailable(GIT_BINARY, "git", issues);
    await this.checkCliAvailable(this.configService.getClaudeConfig().cli.executable, "claude", issues);
    await this.checkCliAvailable(this.configService.getGithubConfig().github.cli, "gh", issues);
    await this.checkMemoryDirectoryWritable(issues);

    return { issues, generatedAt: new Date() };
  }

  private checkNodeVersion(issues: EnvironmentValidationIssue[]): void {
    const match = /^v(\d+)\.(\d+)/.exec(process.version);
    const major = match ? Number(match[1]) : 0;
    const minor = match ? Number(match[2]) : 0;
    const meetsMinimum = major > MINIMUM_NODE_MAJOR || (major === MINIMUM_NODE_MAJOR && minor >= MINIMUM_NODE_MINOR);
    if (!meetsMinimum) {
      issues.push({
        check: "node-version",
        severity: "warning",
        message: `Running Node ${process.version}, but this project requires ${MINIMUM_NODE_MAJOR}.${MINIMUM_NODE_MINOR}+ (uses the built-in fetch API and process.loadEnvFile).`,
      });
    }
  }

  private async checkCliAvailable(executable: string, label: string, issues: EnvironmentValidationIssue[]): Promise<void> {
    try {
      await execFileAsync(executable, ["--version"]);
    } catch (error) {
      issues.push({
        check: `cli:${label}`,
        severity: "warning",
        message: `"${executable}" (${label}) was not found on PATH or failed to run: ${error instanceof Error ? error.message : String(error)}. Workflows that depend on it will fail when attempted.`,
      });
    }
  }

  private async checkMemoryDirectoryWritable(issues: EnvironmentValidationIssue[]): Promise<void> {
    const { memory } = this.configService.getControllerConfig();
    try {
      await mkdir(memory.directory, { recursive: true });
      await access(memory.directory, fsConstants.W_OK);
    } catch (error) {
      issues.push({
        check: "memory-directory-writable",
        severity: "warning",
        message: `Project Memory directory "${memory.directory}" could not be created or is not writable: ${error instanceof Error ? error.message : String(error)}. Execution history and autonomous plan history will silently fail to record.`,
      });
    }
  }
}
