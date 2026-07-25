import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Repository } from "../../domain/repository/Repository";
import { createOperationJournal } from "../../journal/index";
import { JournalEntryStatus, JournalOperationType } from "../../journal/types";
import type { IRepositoryRegistry } from "../../repositories/interfaces";
import { GitHealthService } from "../GitHealthService";

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

// Regression coverage for the finding that Git Health Service had no
// Operation Journal dependency at all, so a controller crash that left an
// Operation Journal entry open (in-progress) with no stale lock file --
// which is the *normal* state of a merge left conflicted after the
// controller that started it died -- was never detected as "interrupted."
describe("GitHealthService: Operation Journal corroboration", () => {
  let workDir: string;
  let journalDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "git-health-work-"));
    journalDir = await mkdtemp(path.join(tmpdir(), "git-health-journal-"));

    await git(workDir, ["init", "-b", "main"]);
    await git(workDir, ["config", "user.email", "test@example.com"]);
    await git(workDir, ["config", "user.name", "Test"]);
    await writeFile(path.join(workDir, "shared.txt"), "a\n");
    await git(workDir, ["add", "shared.txt"]);
    await git(workDir, ["commit", "-m", "init"]);

    await git(workDir, ["checkout", "-b", "feature"]);
    await writeFile(path.join(workDir, "shared.txt"), "b\n");
    await git(workDir, ["commit", "-am", "feature change"]);

    await git(workDir, ["checkout", "main"]);
    await writeFile(path.join(workDir, "shared.txt"), "c\n");
    await git(workDir, ["commit", "-am", "main change"]);

    // Provoke a real merge conflict and leave it mid-flight -- no lock file
    // is held once the merge command itself has returned, conflicted or not.
    await execFileAsync("git", ["merge", "feature"], { cwd: workDir }).catch(() => undefined);
  });

  afterEach(async () => {
    await Promise.all([workDir, journalDir].map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("detects an interrupted merge from a stale, still-open journal entry even though no lock file is stale", async () => {
    const repository: Repository = { id: "repo-1", name: "repo-1", path: workDir, defaultBranch: "main", active: true };
    const registry = fakeRegistry(repository);
    const journal = createOperationJournal(journalDir);
    const staleEntry = await journal.record({
      repositoryId: "repo-1",
      correlationId: "corr-1",
      operation: JournalOperationType.Merge,
      status: JournalEntryStatus.InProgress,
      rollbackStrategy: "reset-hard",
      beforeRef: "deadbeef",
      afterRef: undefined,
      startedAt: new Date(Date.now() - 10 * 60_000),
      completedAt: undefined,
      error: undefined,
      metadata: {},
    });

    const healthService = new GitHealthService(registry, journal);
    const health = await healthService.getHealth("repo-1");

    expect(health.locks.staleLockDetected).toBe(false);
    expect(health.inProgressOperation?.kind).toBe("merge");
    expect(health.interruptedOperation).toEqual({ kind: "merge", journalEntryId: staleEntry.id });
  });

  it("does not report an interrupted operation when the matching journal entry is still fresh", async () => {
    const repository: Repository = { id: "repo-1", name: "repo-1", path: workDir, defaultBranch: "main", active: true };
    const registry = fakeRegistry(repository);
    const journal = createOperationJournal(journalDir);
    await journal.record({
      repositoryId: "repo-1",
      correlationId: "corr-1",
      operation: JournalOperationType.Merge,
      status: JournalEntryStatus.InProgress,
      rollbackStrategy: "reset-hard",
      beforeRef: "deadbeef",
      afterRef: undefined,
      startedAt: new Date(),
      completedAt: undefined,
      error: undefined,
      metadata: {},
    });

    const healthService = new GitHealthService(registry, journal);
    const health = await healthService.getHealth("repo-1");

    expect(health.inProgressOperation?.kind).toBe("merge");
    expect(health.interruptedOperation).toBeUndefined();
  });

  it("does not report an interrupted operation when the journal's most recent entry is already completed", async () => {
    const repository: Repository = { id: "repo-1", name: "repo-1", path: workDir, defaultBranch: "main", active: true };
    const registry = fakeRegistry(repository);
    const journal = createOperationJournal(journalDir);
    await journal.record({
      repositoryId: "repo-1",
      correlationId: "corr-1",
      operation: JournalOperationType.Merge,
      status: JournalEntryStatus.Completed,
      rollbackStrategy: "reset-hard",
      beforeRef: "deadbeef",
      afterRef: "cafef00d",
      startedAt: new Date(Date.now() - 10 * 60_000),
      completedAt: new Date(Date.now() - 9 * 60_000),
      error: undefined,
      metadata: {},
    });

    const healthService = new GitHealthService(registry, journal);
    const health = await healthService.getHealth("repo-1");

    expect(health.inProgressOperation?.kind).toBe("merge");
    expect(health.interruptedOperation).toBeUndefined();
  });
});
