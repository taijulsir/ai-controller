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
import type { IOperationJournal } from "../../journal/interfaces";
import type { JournalEntry } from "../../journal/types";
import { PushChangesWorkflow } from "../workflows/PushChangesWorkflow";

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

function passthroughOrchestrator(): ICommandOrchestrator {
  return {
    execute: async <T>(request: OrchestratedOperationRequest<T>): Promise<OrchestratedOperationResult<T>> => ({
      kind: "executed",
      value: await request.run(),
    }),
  };
}

function fakeJournal(): IOperationJournal {
  let counter = 0;
  const entries = new Map<string, JournalEntry>();
  return {
    record: async (entry) => {
      const id = `entry-${++counter}`;
      const full: JournalEntry = { ...entry, id };
      entries.set(id, full);
      return full;
    },
    update: async (id, patch) => {
      const existing = entries.get(id);
      if (!existing) throw new Error(`no such journal entry: ${id}`);
      const updated = { ...existing, ...patch };
      entries.set(id, updated);
      return updated;
    },
    query: async () => [...entries.values()],
    getMostRecent: async () => undefined,
    getById: async (id) => entries.get(id),
  };
}

// Regression coverage for Commit and Push Result Messages -- a real local
// clone pushing to a real local bare "origin", same "compose real git
// output" philosophy as GitHistoryService.test.ts/CreateCommitWorkflow.test.ts.
// Exercises exactly the scenarios the feature's own validation list calls
// out: a single-commit push, a multi-commit push, and a no-op
// already-up-to-date push.
describe("PushChangesWorkflow", () => {
  let bareDir: string;
  let workDir: string;
  let registry: IRepositoryRegistry;
  let gitAdapter: GitAdapter;
  let workflow: PushChangesWorkflow;

  beforeEach(async () => {
    bareDir = await mkdtemp(path.join(tmpdir(), "push-workflow-origin-"));
    await git(bareDir, ["init", "--bare", "-b", "main"]);

    workDir = await mkdtemp(path.join(tmpdir(), "push-workflow-clone-"));
    await git(workDir, ["clone", bareDir, "."]);
    await git(workDir, ["config", "user.email", "alice@example.com"]);
    await git(workDir, ["config", "user.name", "Alice"]);
    await writeFile(path.join(workDir, "base.txt"), "base\n");
    await git(workDir, ["add", "base.txt"]);
    await git(workDir, ["commit", "-m", "init"]);
    await git(workDir, ["push", "-u", "origin", "main"]);

    const repository: Repository = { id: "repo-1", name: "repo-1", path: workDir, defaultBranch: "main", active: true };
    registry = fakeRegistry(repository);
    gitAdapter = new GitAdapter(registry, "repo-1");
    workflow = new PushChangesWorkflow(gitAdapter, passthroughOrchestrator(), fakeJournal(), "repo-1", "corr-1");
  });

  afterEach(async () => {
    await rm(bareDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it("reports a single pushed commit", async () => {
    await writeFile(path.join(workDir, "feature.ts"), "export const x = 1;\n");
    await git(workDir, ["add", "-A"]);
    await git(workDir, ["commit", "-m", "feat: add feature"]);

    const result = await workflow.execute({ type: "push-changes" }, new AbortController().signal);

    expect(result.success).toBe(true);
    const push = result.pushCompleted!;
    expect(push.branch).toBe("main");
    expect(push.remote).toBe("origin");
    expect(push.pushedCommits).toHaveLength(1);
    expect(push.pushedCommits[0].message).toBe("feat: add feature");
    expect(push.headMessage).toContain("feat: add feature");
    expect(push.ahead).toBe(0);
    expect(push.behind).toBe(0);
  });

  it("reports every pushed commit, most recent first, for a multi-commit push", async () => {
    await writeFile(path.join(workDir, "a.ts"), "a\n");
    await git(workDir, ["add", "-A"]);
    await git(workDir, ["commit", "-m", "Fix payment retry"]);

    await writeFile(path.join(workDir, "b.ts"), "b\n");
    await git(workDir, ["add", "-A"]);
    await git(workDir, ["commit", "-m", "Improve logging"]);

    const result = await workflow.execute({ type: "push-changes" }, new AbortController().signal);

    const push = result.pushCompleted!;
    expect(push.pushedCommits).toHaveLength(2);
    expect(push.pushedCommits.map((c) => c.message)).toEqual(["Improve logging", "Fix payment retry"]);
  });

  it("reports zero pushed commits for a no-op push, without erroring", async () => {
    const result = await workflow.execute({ type: "push-changes" }, new AbortController().signal);

    expect(result.success).toBe(true);
    const push = result.pushCompleted!;
    expect(push.pushedCommits).toEqual([]);
    expect(push.ahead).toBe(0);
    expect(push.behind).toBe(0);
  });
});
