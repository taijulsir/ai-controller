import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Repository } from "../../domain/repository/Repository";
import type { IRepositoryRegistry } from "../../repositories/interfaces";
import { BranchNotFoundError, CommitNotFoundError } from "../errors";
import { GitHistoryService } from "../GitHistoryService";

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

// Regression coverage for the Git History & Inspection System's own /history,
// /show, /diff commands -- real temp git repos, same convention as
// GitHealthService.test.ts, since GitHistoryService's whole job is composing
// real git output.
describe("GitHistoryService", () => {
  let workDir: string;
  let registry: IRepositoryRegistry;
  let service: GitHistoryService;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "git-history-"));
    const repository: Repository = { id: "repo-1", name: "repo-1", path: workDir, defaultBranch: "main", active: true };
    registry = fakeRegistry(repository);
    service = new GitHistoryService(registry);
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function setUpRepo(): Promise<void> {
    await git(workDir, ["init", "-b", "main"]);
    await git(workDir, ["config", "user.email", "alice@example.com"]);
    await git(workDir, ["config", "user.name", "Alice"]);
    await writeFile(path.join(workDir, "base.txt"), "base\n");
    await git(workDir, ["add", "base.txt"]);
    await git(workDir, ["commit", "-m", "init"]);

    await git(workDir, ["config", "user.email", "bob@example.com"]);
    await git(workDir, ["config", "user.name", "Bob"]);
    await writeFile(path.join(workDir, "login.ts"), "login\n");
    await git(workDir, ["add", "login.ts"]);
    await git(workDir, ["commit", "-m", "feat: add login"]);

    await git(workDir, ["config", "user.email", "alice@example.com"]);
    await git(workDir, ["config", "user.name", "Alice"]);
    await writeFile(path.join(workDir, "base.txt"), "base\nmore\n");
    await git(workDir, ["commit", "-am", "fix: payment bug"]);

    await git(workDir, ["checkout", "-b", "feature/x"]);
    await git(workDir, ["config", "user.email", "bob@example.com"]);
    await git(workDir, ["config", "user.name", "Bob"]);
    await writeFile(path.join(workDir, "feature.txt"), "feature\n");
    await git(workDir, ["add", "feature.txt"]);
    await git(workDir, ["commit", "-m", "feat: add feature x"]);
    await git(workDir, ["checkout", "main"]);
  }

  describe("getHistory", () => {
    it("returns commits newest-first, with the current branch and head sha", async () => {
      await setUpRepo();
      const result = await service.getHistory("repo-1", {});

      expect(result.commits).toHaveLength(3);
      expect(result.commits.map((c) => c.message)).toEqual(["fix: payment bug", "feat: add login", "init"]);
      expect(result.currentBranch).toBe("main");
      expect(result.detachedHead).toBe(false);
      expect(result.headSha).toBe(result.commits[0].sha);
      expect(result.repositoryId).toBe("repo-1");
    });

    it("honors an explicit limit", async () => {
      await setUpRepo();
      const result = await service.getHistory("repo-1", { limit: 1 });
      expect(result.commits).toHaveLength(1);
      expect(result.commits[0].message).toBe("fix: payment bug");
    });

    it("filters by branch", async () => {
      await setUpRepo();
      const result = await service.getHistory("repo-1", { branch: "feature/x" });
      expect(result.commits.map((c) => c.message)).toEqual(["feat: add feature x", "fix: payment bug", "feat: add login", "init"]);
    });

    it("throws BranchNotFoundError for an unknown branch", async () => {
      await setUpRepo();
      await expect(service.getHistory("repo-1", { branch: "does-not-exist" })).rejects.toBeInstanceOf(BranchNotFoundError);
    });

    it("filters by author", async () => {
      await setUpRepo();
      const result = await service.getHistory("repo-1", { author: "Bob" });
      expect(result.commits.map((c) => c.message)).toEqual(["feat: add login"]);
    });

    it("filters by search text, case-insensitively", async () => {
      await setUpRepo();
      const result = await service.getHistory("repo-1", { search: "PAYMENT" });
      expect(result.commits.map((c) => c.message)).toEqual(["fix: payment bug"]);
    });

    it("returns an empty result, not an error, for a repository with no commits yet", async () => {
      await git(workDir, ["init", "-b", "main"]);
      const result = await service.getHistory("repo-1", {});
      expect(result.commits).toEqual([]);
    });

    it("marks detachedHead and omits a branch marker when HEAD is detached", async () => {
      await setUpRepo();
      const headSha = await git(workDir, ["rev-parse", "HEAD"]);
      await git(workDir, ["checkout", headSha]);

      const result = await service.getHistory("repo-1", {});
      expect(result.detachedHead).toBe(true);
    });
  });

  describe("getCommitDetail", () => {
    it("returns full metadata, file changes, and aggregate stats for a modifying commit", async () => {
      await setUpRepo();
      const headSha = await git(workDir, ["log", "--format=%H", "-n", "1"]);
      const detail = await service.getCommitDetail("repo-1", headSha);

      expect(detail.subject).toBe("fix: payment bug");
      expect(detail.authorName).toBe("Alice");
      expect(detail.authorEmail).toBe("alice@example.com");
      expect(detail.parents).toHaveLength(1);
      expect(detail.files).toEqual([{ path: "base.txt", status: "modified" }]);
      expect(detail.filesChanged).toBe(1);
      expect(detail.insertions).toBeGreaterThan(0);
      expect(detail.isHead).toBe(true);
      expect(detail.currentBranch).toBe("main");
    });

    it("reports isHead false and no currentBranch for a non-tip commit", async () => {
      await setUpRepo();
      const rootSha = await git(workDir, ["log", "--format=%H", "--reverse"]).then((out) => out.split("\n")[0]);
      const detail = await service.getCommitDetail("repo-1", rootSha);

      expect(detail.isHead).toBe(false);
      expect(detail.currentBranch).toBeUndefined();
    });

    it("shows zero parents and every file as added for the root commit", async () => {
      await setUpRepo();
      const rootSha = await git(workDir, ["log", "--format=%H", "--reverse"]).then((out) => out.split("\n")[0]);
      const detail = await service.getCommitDetail("repo-1", rootSha);

      expect(detail.parents).toEqual([]);
      expect(detail.files).toEqual([{ path: "base.txt", status: "added" }]);
    });

    it("throws CommitNotFoundError for a hash that doesn't resolve", async () => {
      await setUpRepo();
      await expect(service.getCommitDetail("repo-1", "0000000000000000000000000000000000dead")).rejects.toBeInstanceOf(CommitNotFoundError);
    });
  });

  describe("getCommitDiffStat", () => {
    it("returns per-file insertion/deletion counts and matching aggregate totals", async () => {
      await setUpRepo();
      const headSha = await git(workDir, ["rev-parse", "HEAD"]);
      const result = await service.getCommitDiffStat("repo-1", headSha);

      expect(result.files).toEqual([{ path: "base.txt", insertions: 1, deletions: 0, binary: false }]);
      expect(result.filesChanged).toBe(1);
      expect(result.insertions).toBe(1);
      expect(result.deletions).toBe(0);
    });

    it("throws CommitNotFoundError for a hash that doesn't resolve", async () => {
      await setUpRepo();
      await expect(service.getCommitDiffStat("repo-1", "0000000000000000000000000000000000dead")).rejects.toBeInstanceOf(CommitNotFoundError);
    });
  });
});
