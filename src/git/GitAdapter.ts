import { randomUUID } from "node:crypto";
import { readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Repository } from "../domain/repository/Repository";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import { GitCommandRunner } from "./GitCommandRunner";
import { DEFAULT_RECENT_COMMITS_LIMIT, GitCommand } from "./GitConstants";
import { GitCommandError, NoActiveRepositoryError } from "./errors";
import { parseGitLog } from "./GitLogParser";
import { parseGitStatus } from "./GitStatusParser";
import type { IGitAdapter } from "./interfaces";
import type { CommitSummary, GitFileChange, GitStatus } from "./types";

export class GitAdapter implements IGitAdapter {
  constructor(
    private readonly repositoryRegistry: IRepositoryRegistry,
    private readonly repositoryId?: string,
    private readonly commandRunner: GitCommandRunner = new GitCommandRunner(),
  ) {}

  async status(): Promise<GitStatus> {
    const output = await this.run(GitCommand.status());
    return parseGitStatus(output);
  }

  async currentBranch(): Promise<string> {
    return this.run(GitCommand.currentBranch());
  }

  async listBranches(): Promise<string[]> {
    const output = await this.run(GitCommand.listBranches());
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async checkout(branch: string): Promise<void> {
    await this.run(GitCommand.checkout(branch));
  }

  async createBranch(branch: string): Promise<void> {
    await this.run(GitCommand.createBranch(branch));
  }

  async stageAll(): Promise<void> {
    await this.run(GitCommand.stageAll());
  }

  async commit(message: string): Promise<void> {
    await this.run(GitCommand.commit(message));
  }

  async push(): Promise<void> {
    await this.run(GitCommand.push());
  }

  async getRecentCommits(limit: number = DEFAULT_RECENT_COMMITS_LIMIT): Promise<CommitSummary[]> {
    const output = await this.run(GitCommand.recentCommits(limit));
    return parseGitLog(output);
  }

  // Deliberately not `git stash create`: verified empirically that it (a)
  // never sees untracked files -- it mirrors `git stash push` with none of
  // that command's options, and has no flag to include them -- which would
  // silently make a newly-created file invisible to undo entirely, and (b)
  // fails outright ("You do not have the initial commit yet") on a
  // repository with zero commits. A throwaway GIT_INDEX_FILE has neither
  // problem: `add -A` into it stages tracked, modified, untracked, and
  // deleted paths alike (respecting .gitignore, same as any other `add -A`),
  // and `write-tree` needs no HEAD at all. The repository's real index is
  // never touched -- both commands run against the temporary one only.
  async createSnapshot(): Promise<string> {
    const repository = this.resolveRepository();
    const tempIndexPath = path.join(tmpdir(), `ai-controller-undo-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: tempIndexPath };
    try {
      await this.commandRunner.run(repository.path, GitCommand.addAll(), env);
      return await this.commandRunner.run(repository.path, GitCommand.writeTree(), env);
    } finally {
      await unlink(tempIndexPath).catch(() => {});
    }
  }

  async diffChangedFiles(from: string, to: string): Promise<GitFileChange[]> {
    const output = await this.run(GitCommand.diffNameStatus(from, to));
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [statusCode, ...pathParts] = line.split("\t");
        return { path: pathParts.join("\t"), status: this.mapDiffStatus(statusCode) };
      });
  }

  async restorePaths(fromTreeish: string, filesToRestore: string[], filesToDelete: string[]): Promise<void> {
    const repository = this.resolveRepository();

    if (filesToRestore.length > 0) {
      await this.run(GitCommand.restorePaths(fromTreeish, filesToRestore));
    }

    for (const relativePath of filesToDelete) {
      const absolutePath = path.join(repository.path, relativePath);
      await unlink(absolutePath).catch(() => {});
      await this.pruneEmptyParentDirectories(repository.path, path.dirname(absolutePath));
    }
  }

  // Git tracks files, not directories: deleting the last file in a directory
  // (as undoing a newly-created file often does) leaves an empty directory
  // sitting on disk -- git itself never cleans these up. Walks upward from
  // the deleted file's own directory, removing each one only if it is now
  // completely empty, stopping at the repository root (never above it, and
  // never touching the root itself even if it were somehow empty).
  private async pruneEmptyParentDirectories(repositoryRoot: string, directory: string): Promise<void> {
    let current = directory;
    while (current !== repositoryRoot && current.startsWith(repositoryRoot)) {
      const entries = await readdir(current).catch(() => undefined);
      if (!entries || entries.length > 0) {
        return;
      }
      await rmdir(current).catch(() => {});
      current = path.dirname(current);
    }
  }

  async fetch(): Promise<void> {
    await this.run(GitCommand.fetch());
  }

  // Verified behavior: `git merge-base --is-ancestor` exits 0 for "yes",
  // exits 1 for a plain "no" (e.g. unrelated or diverged histories) -- both
  // normal outcomes, never an error. Any other exit code (a bad ref, a
  // corrupt repository, etc.) is a genuine failure and is rethrown
  // unchanged, not swallowed into "false".
  async isAncestor(ancestor: string, ref: string): Promise<boolean> {
    try {
      await this.run(GitCommand.isAncestor(ancestor, ref));
      return true;
    } catch (error) {
      if (error instanceof GitCommandError && error.exitCode === 1) {
        return false;
      }
      throw error;
    }
  }

  async fastForward(ref: string): Promise<void> {
    await this.run(GitCommand.fastForwardMerge(ref));
  }

  async mergeBranch(ref: string): Promise<void> {
    await this.run(GitCommand.merge(ref));
  }

  async abortMerge(): Promise<void> {
    await this.run(GitCommand.abortMerge());
  }

  private mapDiffStatus(statusCode: string): GitFileChange["status"] {
    if (statusCode.startsWith("A")) return "added";
    if (statusCode.startsWith("D")) return "deleted";
    return "modified";
  }

  private async run(args: string[]): Promise<string> {
    const repository = this.resolveRepository();
    return this.commandRunner.run(repository.path, args);
  }

  private resolveRepository(): Repository {
    if (this.repositoryId) {
      return this.repositoryRegistry.getRepository(this.repositoryId);
    }

    const activeRepository = this.repositoryRegistry.getActiveRepository();
    if (!activeRepository) {
      throw new NoActiveRepositoryError();
    }
    return activeRepository;
  }
}
