import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitAdapter } from "../../git/GitAdapter";
import type { Repository } from "../../domain/repository/Repository";
import type { IRepositoryRegistry } from "../../repositories/interfaces";
import type { ICommandOrchestrator } from "../../gitorchestration/interfaces";
import type { OrchestratedOperationRequest, OrchestratedOperationResult } from "../../gitorchestration/types";
import type { IGitTransactionManager } from "../../gittransaction/interfaces";
import type { Transaction, TransactionOptions } from "../../gittransaction/types";
import { CreateCommitWorkflow } from "../workflows/CreateCommitWorkflow";
import type { CreateCommitTask } from "../types";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

function fakeRegistry(repository: Repository): IRepositoryRegistry {
  return {
    getAllRepositories: () => [repository],
    getRepository: () => repository,
    getActiveRepository: () => repository,
    setActiveRepository: () => {},
    repositoryExists: () => true,
    refresh: () => {},
  };
}

// Bypasses Pre-flight Validation Policy/approval gating entirely -- this
// suite is about what CreateCommitWorkflow composes into WorkflowResult once
// gating has already said "go", not about gating itself (that's
// PreflightValidationPolicy's own test file).
function passthroughOrchestrator(): ICommandOrchestrator {
  return {
    execute: async <T>(request: OrchestratedOperationRequest<T>): Promise<OrchestratedOperationResult<T>> => ({
      kind: "executed",
      value: await request.run(),
    }),
  };
}

function noopTransactionManager(): IGitTransactionManager {
  return {
    begin: async (options: TransactionOptions): Promise<Transaction> => ({
      journalEntryId: "txn-1",
      beforeRef: "before",
      commit: async () => {},
      rollback: async () => {},
    }),
  };
}

// Regression coverage for Commit and Push Result Messages -- real temp git
// repo, same convention as GitHistoryService.test.ts/GitHealthService.test.ts,
// since the whole point of buildCommitCreationResult is composing real git
// output (file changes, stats, short sha) into WorkflowResult.commitCreated.
describe("CreateCommitWorkflow", () => {
  let workDir: string;
  let registry: IRepositoryRegistry;
  let gitAdapter: GitAdapter;
  let workflow: CreateCommitWorkflow;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "create-commit-workflow-"));
    const repository: Repository = { id: "repo-1", name: "repo-1", path: workDir, defaultBranch: "main", active: true };
    registry = fakeRegistry(repository);
    gitAdapter = new GitAdapter(registry, "repo-1");
    workflow = new CreateCommitWorkflow(gitAdapter, passthroughOrchestrator(), noopTransactionManager(), "repo-1", "corr-1");

    await git(workDir, ["init", "-b", "main"]);
    await git(workDir, ["config", "user.email", "alice@example.com"]);
    await git(workDir, ["config", "user.name", "Alice"]);
    await writeFile(path.join(workDir, "base.txt"), "base\n");
    await git(workDir, ["add", "base.txt"]);
    await git(workDir, ["commit", "-m", "init"]);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("composes a commitCreated summary for a single changed file", async () => {
    await writeFile(path.join(workDir, "feature.ts"), "export const x = 1;\n");
    const task: CreateCommitTask = { type: "create-commit", input: { message: "feat: add feature" } };

    const result = await workflow.execute(task, new AbortController().signal);

    expect(result.success).toBe(true);
    expect(result.commitCreated).toBeDefined();
    const summary = result.commitCreated!;
    expect(summary.branch).toBe("main");
    expect(summary.message).toBe("feat: add feature");
    expect(summary.sha).toHaveLength(40);
    expect(summary.shortSha.length).toBeGreaterThan(0);
    expect(summary.filesChanged).toBe(1);
    expect(summary.files).toEqual([{ path: "feature.ts", status: "added" }]);
    expect(summary.insertions).toBe(1);
    expect(summary.deletions).toBe(0);
    expect(summary.timestamp).toBeInstanceOf(Date);
  });

  it("composes a commitCreated summary spanning multiple changed files", async () => {
    await writeFile(path.join(workDir, "base.txt"), "base\nmodified\n");
    await writeFile(path.join(workDir, "new-one.ts"), "one\n");
    await writeFile(path.join(workDir, "new-two.ts"), "two\n");
    const task: CreateCommitTask = { type: "create-commit", input: { message: "feat: multi-file change" } };

    const result = await workflow.execute(task, new AbortController().signal);

    const summary = result.commitCreated!;
    expect(summary.filesChanged).toBe(3);
    expect(summary.files.map((f) => f.path).sort()).toEqual(["base.txt", "new-one.ts", "new-two.ts"]);
    expect(summary.insertions).toBeGreaterThanOrEqual(3);
  });

  it("preserves a full multi-line commit message, not just its subject line", async () => {
    await writeFile(path.join(workDir, "feature.ts"), "export const x = 1;\n");
    const message = "feat: add feature\n\nLonger explanation of why this change was made.";
    const task: CreateCommitTask = { type: "create-commit", input: { message } };

    const result = await workflow.execute(task, new AbortController().signal);

    expect(result.commitCreated!.message).toBe(message);
  });
});
