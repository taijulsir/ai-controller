import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IConfigService } from "../src/config/interfaces";
import type {
  ClaudeConfig,
  ControllerConfig,
  GithubConfig,
  TelegramConfig,
} from "../src/config/types";
import type { Repository } from "../src/domain/repository/Repository";
import { EnvironmentValidator } from "../src/startup/EnvironmentValidator";

class FakeConfigService implements IConfigService {
  constructor(
    private readonly memoryDirectory: string,
    private readonly claudeExecutable: string,
    private readonly githubCli: string,
  ) {}

  getControllerConfig(): ControllerConfig {
    return {
      controller: { name: "test", version: "0.0.0", environment: "test" },
      workspace: { root: "/tmp" },
      task: { max_concurrent_jobs: 1, timeout_minutes: 5 },
      approval: { mode: "manual", require_before_git_push: true, require_before_pull_request: false },
      logging: { enabled: false, level: "info", directory: "/tmp" },
      memory: { enabled: true, directory: this.memoryDirectory },
    };
  }
  getClaudeConfig(): ClaudeConfig {
    return {
      provider: { name: "anthropic" },
      cli: { executable: this.claudeExecutable },
      execution: { approval_mode: "default", max_execution_minutes: 5 },
      session: { resume_previous: false },
    };
  }
  getGithubConfig(): GithubConfig {
    return { github: { cli: this.githubCli }, git: { default_branch: "main" }, pull_request: { auto_create: false, auto_merge: false } };
  }
  getTelegramConfig(): TelegramConfig {
    throw new Error("not used in this verification script");
  }
  getRepositories(): Repository[] {
    throw new Error("not used in this verification script");
  }
  reload(): void {}
}

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

async function main(): Promise<void> {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "env-validator-"));
  const writableMemoryDir = path.join(tempRoot, "memory");
  const readonlyMemoryDir = path.join(tempRoot, "readonly-memory");

  try {
    // --- Everything present and healthy: "node" is guaranteed present on
    // PATH in any environment capable of running this script at all, so it
    // stands in for a real, always-resolvable CLI without depending on git/
    // claude/gh specifically being installed in whatever environment runs
    // this script. GIT_BINARY itself is not injectable (hardcoded "git" in
    // src/git/GitConstants.ts, matching architecture.md's "GitAdapter runs
    // ... via git's CLI only" — not config-driven) so its check is exercised
    // against whatever's actually on PATH in this environment, not faked.
    const healthyValidator = new EnvironmentValidator(new FakeConfigService(writableMemoryDir, "node", "node"));
    const healthyReport = await healthyValidator.validate();

    assert(
      !healthyReport.issues.some((issue) => issue.check === "cli:claude"),
      "validate() reports no issue when the configured claude executable resolves on PATH",
    );
    assert(
      !healthyReport.issues.some((issue) => issue.check === "cli:gh"),
      "validate() reports no issue when the configured gh executable resolves on PATH",
    );
    assert(
      !healthyReport.issues.some((issue) => issue.check === "memory-directory-writable"),
      "validate() reports no issue for a writable, creatable memory directory",
    );
    assert(
      !healthyReport.issues.some((issue) => issue.check === "node-version"),
      `validate() reports no node-version issue on the Node version actually running this script (${process.version})`,
    );
    assert(
      healthyReport.generatedAt instanceof Date,
      "validate() returns a report stamped with generatedAt",
    );

    // --- A missing CLI executable is reported, not thrown ---
    const missingCliValidator = new EnvironmentValidator(
      new FakeConfigService(writableMemoryDir, "this-binary-does-not-exist-xyz", "node"),
    );
    const missingCliReport = await missingCliValidator.validate();
    const claudeIssue = missingCliReport.issues.find((issue) => issue.check === "cli:claude");
    assert(claudeIssue !== undefined, "validate() reports an issue for a claude executable that isn't on PATH");
    assert(
      claudeIssue?.severity === "warning",
      "a missing CLI is reported as a warning, not treated as fatal (claude/gh are only required for specific workflows)",
    );

    // --- An unwritable memory directory is reported, not thrown ---
    mkdirSync(readonlyMemoryDir, { recursive: true });
    chmodSync(readonlyMemoryDir, 0o444);
    try {
      const readonlyValidator = new EnvironmentValidator(new FakeConfigService(readonlyMemoryDir, "node", "node"));
      const readonlyReport = await readonlyValidator.validate();
      assert(
        readonlyReport.issues.some((issue) => issue.check === "memory-directory-writable"),
        "validate() reports an issue for a memory directory that exists but isn't writable",
      );
    } finally {
      chmodSync(readonlyMemoryDir, 0o755);
    }

    // --- validate() never throws, regardless of what it finds ---
    let threw = false;
    try {
      await new EnvironmentValidator(
        new FakeConfigService(readonlyMemoryDir, "also-does-not-exist", "also-does-not-exist"),
      ).validate();
    } catch {
      threw = true;
    }
    assert(!threw, "validate() never throws — every check result is reported, none are fatal by construction");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exitCode = 1;
});
