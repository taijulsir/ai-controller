import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Repository } from "../../domain/repository/Repository";
import type { CurrentTaskSnapshot } from "../../executionstate/types";
import type { IExecutionStateReader } from "../../executionstate/interfaces";
import { GitTransactionManager } from "../../gittransaction/GitTransactionManager";
import { createOperationJournal } from "../../journal/index";
import type { IRepositoryRegistry } from "../../repositories/interfaces";
import { GitHealthService } from "../GitHealthService";
import { RepositorySnapshotService } from "../RepositorySnapshotService";
import { SafeUndoFramework } from "../../undo/SafeUndoFramework";
import { CannotExecuteDiscardPlanError, WorkingTreeChangeNotFoundError } from "../errors";
import { WorkingTreeService } from "../WorkingTreeService";

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

function noExecution(): IExecutionStateReader {
  return { getCurrent: () => undefined };
}

function executionInProgress(snapshot: Partial<CurrentTaskSnapshot> = {}): IExecutionStateReader {
  const full: CurrentTaskSnapshot = {
    repositoryId: "repo-1",
    task: "implement-feature",
    workflow: "",
    correlationId: "corr-1",
    startedAt: new Date(),
    executor: "test",
    depth: 1,
    ...snapshot,
  };
  return { getCurrent: () => full };
}

// Working Tree Management (/changes, /showchanges, /discard <index>,
// /discard all) -- real-repo integration coverage, the same pattern
// src/gitorchestration/__tests__/integration.test.ts already establishes for
// git-heavy logic: a real temp repository, real git commands, real
// FilesystemJournalStorage-backed journal, real GitTransactionManager. Unit
// coverage for the underlying porcelain parsing lives separately in
// GitStatusParser.test.ts (fixture-based, faster, covers shapes that are
// awkward to reliably reproduce via real git).
describe("WorkingTreeService (real repo)", () => {
  let repoDir: string;
  let journalDir: string;
  let service: WorkingTreeService;
  let registry: IRepositoryRegistry;
  let transactionManager: GitTransactionManager;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), "wts-repo-"));
    journalDir = await mkdtemp(path.join(tmpdir(), "wts-journal-"));

    await git(repoDir, ["init", "-b", "main"]);
    await git(repoDir, ["config", "user.email", "test@example.com"]);
    await git(repoDir, ["config", "user.name", "Test"]);
    await writeFile(path.join(repoDir, "tracked.txt"), "original content\n");
    await writeFile(path.join(repoDir, "to-delete.txt"), "will be deleted\n");
    await writeFile(path.join(repoDir, "to-rename.txt"), "rename me please, this content is long enough for git to detect a rename\n");
    await git(repoDir, ["add", "-A"]);
    await git(repoDir, ["commit", "-m", "init"]);

    const repository: Repository = { id: "repo-1", name: "repo-1", path: repoDir, defaultBranch: "main", active: true };
    registry = fakeRegistry(repository);

    const journal = createOperationJournal(journalDir);
    const snapshotService = new RepositorySnapshotService(registry);
    transactionManager = new GitTransactionManager(snapshotService, journal, registry);
    const gitHealthService = new GitHealthService(registry, journal);

    service = new WorkingTreeService(registry, transactionManager, noExecution(), gitHealthService);
  });

  afterEach(async () => {
    await Promise.all([repoDir, journalDir].map((dir) => rm(dir, { recursive: true, force: true })));
  });

  describe("getChanges", () => {
    it("reports a clean tree with no changes right after the initial commit", async () => {
      const result = await service.getChanges("repo-1");
      expect(result).toEqual({ repositoryId: "repo-1", changes: [], stagedCount: 0, unstagedCount: 0, untrackedCount: 0, isClean: true });
    });

    it("classifies an unstaged-modified tracked file", async () => {
      await writeFile(path.join(repoDir, "tracked.txt"), "changed content\n");
      const result = await service.getChanges("repo-1");
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0]).toMatchObject({ path: "tracked.txt", status: "modified", staged: false, unstaged: true });
      expect(result.unstagedCount).toBe(1);
      expect(result.stagedCount).toBe(0);
    });

    it("classifies a staged-modified tracked file", async () => {
      await writeFile(path.join(repoDir, "tracked.txt"), "changed content\n");
      await git(repoDir, ["add", "tracked.txt"]);
      const result = await service.getChanges("repo-1");
      expect(result.changes[0]).toMatchObject({ status: "modified", staged: true, unstaged: false });
      expect(result.stagedCount).toBe(1);
    });

    it("classifies a staged-added (new, git-add'ed) file", async () => {
      await writeFile(path.join(repoDir, "brand-new.txt"), "new file\n");
      await git(repoDir, ["add", "brand-new.txt"]);
      const result = await service.getChanges("repo-1");
      expect(result.changes[0]).toMatchObject({ path: "brand-new.txt", status: "added", staged: true, unstaged: false });
    });

    it("classifies an untracked (not yet added) file separately from added, with its own count", async () => {
      await writeFile(path.join(repoDir, "brand-new.txt"), "new file\n");
      const result = await service.getChanges("repo-1");
      expect(result.changes[0]).toMatchObject({ path: "brand-new.txt", status: "untracked", staged: false, unstaged: false });
      expect(result.untrackedCount).toBe(1);
      expect(result.stagedCount).toBe(0);
      expect(result.unstagedCount).toBe(0);
    });

    it("classifies a deleted (unstaged) tracked file", async () => {
      await rm(path.join(repoDir, "to-delete.txt"));
      const result = await service.getChanges("repo-1");
      expect(result.changes[0]).toMatchObject({ path: "to-delete.txt", status: "deleted", staged: false, unstaged: true });
    });

    it("classifies a staged rename, carrying the original path", async () => {
      await git(repoDir, ["mv", "to-rename.txt", "renamed.txt"]);
      const result = await service.getChanges("repo-1");
      expect(result.changes[0]).toMatchObject({ path: "renamed.txt", status: "renamed", renamedFrom: "to-rename.txt", staged: true });
    });

    it("assigns stable sequential indexes across a mix of every status", async () => {
      await writeFile(path.join(repoDir, "tracked.txt"), "changed\n");
      await rm(path.join(repoDir, "to-delete.txt"));
      await writeFile(path.join(repoDir, "brand-new.txt"), "new\n");

      const result = await service.getChanges("repo-1");
      const indexes = result.changes.map((change) => change.index);
      expect(indexes).toEqual([1, 2, 3]);
      expect(new Set(indexes).size).toBe(3);
    });
  });

  describe("getChangeDiff", () => {
    it("returns real diff content for an unstaged modification", async () => {
      await writeFile(path.join(repoDir, "tracked.txt"), "changed content\n");
      const result = await service.getChangeDiff("repo-1", 1);
      expect(result.diff).toContain("-original content");
      expect(result.diff).toContain("+changed content");
    });

    it("returns real diff content for a staged modification", async () => {
      await writeFile(path.join(repoDir, "tracked.txt"), "changed content\n");
      await git(repoDir, ["add", "tracked.txt"]);
      const result = await service.getChangeDiff("repo-1", 1);
      expect(result.diff).toContain("+changed content");
    });

    it("returns a synthetic added-file diff for an untracked file", async () => {
      await writeFile(path.join(repoDir, "brand-new.txt"), "hello world\n");
      const result = await service.getChangeDiff("repo-1", 1);
      expect(result.diff).toContain("new file mode");
      expect(result.diff).toContain("+hello world");
    });

    it("throws WorkingTreeChangeNotFoundError for an index that doesn't resolve", async () => {
      await expect(service.getChangeDiff("repo-1", 99)).rejects.toThrow(WorkingTreeChangeNotFoundError);
    });

    it("throws WorkingTreeChangeNotFoundError when the tree is entirely clean", async () => {
      await expect(service.getChangeDiff("repo-1", 1)).rejects.toThrow(WorkingTreeChangeNotFoundError);
    });
  });

  describe("buildDiscardPlan", () => {
    it("reports nothing-to-discard for target 'all' on a clean tree", async () => {
      const plan = await service.buildDiscardPlan("repo-1", { kind: "all" });
      expect(plan.status).toBe("nothing-to-discard");
      expect(plan.changes).toEqual([]);
    });

    it("throws WorkingTreeChangeNotFoundError for an out-of-range index target", async () => {
      await expect(service.buildDiscardPlan("repo-1", { kind: "index", index: 5 })).rejects.toThrow(WorkingTreeChangeNotFoundError);
    });

    it("refuses with execution-in-progress when a Claude task is currently running for the repository", async () => {
      const busyService = new WorkingTreeService(
        registry,
        transactionManager,
        executionInProgress(),
        new GitHealthService(registry, createOperationJournal(journalDir)),
      );
      await writeFile(path.join(repoDir, "tracked.txt"), "changed\n");
      const plan = await busyService.buildDiscardPlan("repo-1", { kind: "all" });
      expect(plan.status).toBe("execution-in-progress");
      expect(plan.changes).toEqual([]);
    });

    it("refuses with operation-in-progress while a merge conflict is unresolved", async () => {
      // Create a real conflicting merge so GitHealthService genuinely reports
      // inProgressOperation -- not a fake, since this is exactly the
      // condition the guard exists to detect.
      await git(repoDir, ["checkout", "-b", "feature"]);
      await writeFile(path.join(repoDir, "tracked.txt"), "feature branch content\n");
      await git(repoDir, ["commit", "-am", "feature change"]);
      await git(repoDir, ["checkout", "main"]);
      await writeFile(path.join(repoDir, "tracked.txt"), "main branch content\n");
      await git(repoDir, ["commit", "-am", "main change"]);
      await execFileAsync("git", ["merge", "feature"], { cwd: repoDir }).catch(() => {
        // Expected: the merge conflicts and exits non-zero.
      });

      const plan = await service.buildDiscardPlan("repo-1", { kind: "all" });
      expect(plan.status).toBe("operation-in-progress");

      await git(repoDir, ["merge", "--abort"]);
    });

    it("builds a ready plan for a single index, carrying only that one change", async () => {
      await writeFile(path.join(repoDir, "tracked.txt"), "changed\n");
      await rm(path.join(repoDir, "to-delete.txt"));

      const { changes } = await service.getChanges("repo-1");
      const target = changes.find((change) => change.path === "to-delete.txt")!;

      const plan = await service.buildDiscardPlan("repo-1", { kind: "index", index: target.index });
      expect(plan.status).toBe("ready");
      expect(plan.changes).toHaveLength(1);
      expect(plan.changes[0].path).toBe("to-delete.txt");
    });

    it("builds a ready plan for 'all', carrying every change", async () => {
      await writeFile(path.join(repoDir, "tracked.txt"), "changed\n");
      await rm(path.join(repoDir, "to-delete.txt"));

      const plan = await service.buildDiscardPlan("repo-1", { kind: "all" });
      expect(plan.status).toBe("ready");
      expect(plan.changes).toHaveLength(2);
    });
  });

  describe("executeDiscardPlan", () => {
    it("throws CannotExecuteDiscardPlanError for a plan that isn't ready", async () => {
      const plan = await service.buildDiscardPlan("repo-1", { kind: "all" });
      expect(plan.status).toBe("nothing-to-discard");
      await expect(service.executeDiscardPlan(plan)).rejects.toThrow(CannotExecuteDiscardPlanError);
    });

    it("discards a single unstaged-modified file, restoring its original content, without touching other changes", async () => {
      await writeFile(path.join(repoDir, "tracked.txt"), "changed\n");
      await writeFile(path.join(repoDir, "untouched.txt"), "should stay untracked\n");

      const plan = await service.buildDiscardPlan("repo-1", { kind: "index", index: 1 });
      const outcome = await service.executeDiscardPlan(plan);

      expect(outcome.affectedFiles).toEqual(["tracked.txt"]);
      const content = await readFile(path.join(repoDir, "tracked.txt"), "utf8");
      expect(content).toBe("original content\n");
      // The unrelated untracked file must be completely untouched.
      const stillUntracked = await readFile(path.join(repoDir, "untouched.txt"), "utf8");
      expect(stillUntracked).toBe("should stay untracked\n");
      expect(outcome.untrackedCount).toBe(1);
    });

    it("discards a staged-added file by unstaging and deleting it", async () => {
      await writeFile(path.join(repoDir, "brand-new.txt"), "new\n");
      await git(repoDir, ["add", "brand-new.txt"]);

      const plan = await service.buildDiscardPlan("repo-1", { kind: "index", index: 1 });
      await service.executeDiscardPlan(plan);

      await expect(readFile(path.join(repoDir, "brand-new.txt"), "utf8")).rejects.toThrow();
      const status = await git(repoDir, ["status", "--porcelain"]);
      expect(status).toBe("");
    });

    it("discards an untracked file by removing it, never touching .gitignore'd files", async () => {
      await writeFile(path.join(repoDir, ".gitignore"), "ignored.txt\n");
      await git(repoDir, ["add", ".gitignore"]);
      await git(repoDir, ["commit", "-m", "add gitignore"]);
      await writeFile(path.join(repoDir, "brand-new.txt"), "new\n");
      await writeFile(path.join(repoDir, "ignored.txt"), "must survive\n");

      const plan = await service.buildDiscardPlan("repo-1", { kind: "index", index: 1 });
      expect(plan.changes[0].path).toBe("brand-new.txt");
      await service.executeDiscardPlan(plan);

      await expect(readFile(path.join(repoDir, "brand-new.txt"), "utf8")).rejects.toThrow();
      const ignoredContent = await readFile(path.join(repoDir, "ignored.txt"), "utf8");
      expect(ignoredContent).toBe("must survive\n");
    });

    it("discards a deleted (unstaged) file by restoring it from HEAD", async () => {
      await rm(path.join(repoDir, "to-delete.txt"));

      const plan = await service.buildDiscardPlan("repo-1", { kind: "index", index: 1 });
      await service.executeDiscardPlan(plan);

      const content = await readFile(path.join(repoDir, "to-delete.txt"), "utf8");
      expect(content).toBe("will be deleted\n");
    });

    it("discards a staged rename by restoring the old path and removing the new one", async () => {
      await git(repoDir, ["mv", "to-rename.txt", "renamed.txt"]);

      const plan = await service.buildDiscardPlan("repo-1", { kind: "index", index: 1 });
      await service.executeDiscardPlan(plan);

      const restored = await readFile(path.join(repoDir, "to-rename.txt"), "utf8");
      expect(restored).toContain("rename me please");
      await expect(readFile(path.join(repoDir, "renamed.txt"), "utf8")).rejects.toThrow();
    });

    it("discards everything with target 'all', leaving a fully clean working tree", async () => {
      await writeFile(path.join(repoDir, "tracked.txt"), "changed\n");
      await rm(path.join(repoDir, "to-delete.txt"));
      await writeFile(path.join(repoDir, "brand-new.txt"), "new\n");
      await git(repoDir, ["add", "brand-new.txt"]);

      const plan = await service.buildDiscardPlan("repo-1", { kind: "all" });
      const outcome = await service.executeDiscardPlan(plan);

      expect(outcome.isClean).toBe(true);
      expect(outcome.affectedFiles.sort()).toEqual(["brand-new.txt", "to-delete.txt", "tracked.txt"].sort());
      const status = await git(repoDir, ["status", "--porcelain"]);
      expect(status).toBe("");
    });

    it("journals the discard so it is undoable via SafeUndoFramework, exactly like DiscardWorkflow's own bare /discard", async () => {
      await writeFile(path.join(repoDir, "tracked.txt"), "changed\n");

      const plan = await service.buildDiscardPlan("repo-1", { kind: "all" });
      await service.executeDiscardPlan(plan);

      const journal = createOperationJournal(journalDir);
      const snapshotService = new RepositorySnapshotService(registry);
      const alwaysApprove = { requestApproval: async () => true };
      const safeUndoFramework = new SafeUndoFramework(journal, registry, snapshotService, alwaysApprove);

      const undoPlan = await safeUndoFramework.buildUndoPlan("repo-1");
      expect(undoPlan).toBeDefined();
      expect(undoPlan!.strategy).toBe("restore-tree");
    });
  });
});
