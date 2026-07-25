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
import type { CommitSummary, GitFileChange, GitStatus, SubmoduleStatus, WorktreeInfo } from "./types";

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

  async diff(from: string, to: string): Promise<string> {
    return this.run(GitCommand.diff(from, to));
  }

  // Binary-safe -- see GitCommandRunner.runBinary's own doc comment for why
  // this can never go through the ordinary string-returning run() above.
  async readFile(treeish: string, filePath: string): Promise<Buffer> {
    const repository = this.resolveRepository();
    return this.commandRunner.runBinary(repository.path, GitCommand.showFile(treeish, filePath));
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

  async headSha(): Promise<string> {
    return this.run(GitCommand.headSha());
  }

  async gitDir(): Promise<string> {
    const repository = this.resolveRepository();
    const output = await this.run(GitCommand.gitDir());
    return path.resolve(repository.path, output);
  }

  async hasUpstreamConfigured(branch: string): Promise<boolean> {
    try {
      await this.run(GitCommand.hasUpstreamConfigured(branch));
      return true;
    } catch {
      return false;
    }
  }

  async upstreamRef(): Promise<string | undefined> {
    try {
      return await this.run(GitCommand.upstreamRef());
    } catch {
      return undefined;
    }
  }

  async stashCount(): Promise<number> {
    const output = await this.run(GitCommand.stashList());
    return output.length === 0 ? 0 : output.split("\n").filter((line) => line.trim().length > 0).length;
  }

  // Parses `git worktree list --porcelain`: records separated by blank
  // lines, each a "worktree <path>" line followed by "HEAD <sha>" and either
  // "branch <ref>" or the literal "detached".
  async listWorktrees(): Promise<WorktreeInfo[]> {
    const repository = this.resolveRepository();
    const output = await this.run(GitCommand.worktreeList());
    const currentPath = path.resolve(repository.path);

    return output
      .split(/\n\n+/)
      .map((record) => record.trim())
      .filter((record) => record.length > 0)
      .map((record) => {
        const lines = record.split("\n");
        const worktreeLine = lines.find((line) => line.startsWith("worktree "));
        const branchLine = lines.find((line) => line.startsWith("branch "));
        const worktreePath = worktreeLine ? worktreeLine.slice("worktree ".length).trim() : "";
        const branch = branchLine ? branchLine.slice("branch ".length).replace(/^refs\/heads\//, "").trim() : undefined;
        return {
          path: worktreePath,
          branch,
          isCurrent: path.resolve(worktreePath) === currentPath,
        };
      });
  }

  // Parses `git submodule status`: a one-character status prefix per line --
  // ' ' clean, '+' dirty (checked-out commit differs from the index), '-'
  // not initialized, 'U' merge conflict (treated as dirty, the same
  // conservative bucket a real conflict inside a submodule belongs in).
  async listSubmodules(): Promise<SubmoduleStatus[]> {
    const output = await this.run(GitCommand.submoduleStatus());
    return output
      .split("\n")
      .map((line) => line)
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const prefix = line[0];
        const rest = line.slice(1).trim();
        const submodulePath = rest.split(/\s+/)[1] ?? rest.split(/\s+/)[0];
        return {
          path: submodulePath,
          isDirty: prefix === "+" || prefix === "U",
          isDetached: false,
          initialized: prefix !== "-",
        };
      });
  }

  async isShallowRepository(): Promise<boolean> {
    const output = await this.run(GitCommand.isShallowRepository());
    return output.trim() === "true";
  }

  async fsck(): Promise<{ clean: boolean; output: string }> {
    try {
      const output = await this.run(GitCommand.fsck());
      return { clean: output.trim().length === 0, output };
    } catch (error) {
      const output = error instanceof GitCommandError ? error.message : String(error);
      return { clean: false, output };
    }
  }

  async rebase(ontoRef: string): Promise<void> {
    await this.run(GitCommand.rebaseOnto(ontoRef));
  }

  async abortRebase(): Promise<void> {
    await this.run(GitCommand.abortRebase());
  }

  async continueRebase(): Promise<void> {
    await this.run(GitCommand.continueRebase());
  }

  async abortCherryPick(): Promise<void> {
    await this.run(GitCommand.abortCherryPick());
  }

  async abortRevert(): Promise<void> {
    await this.run(GitCommand.abortRevert());
  }

  async abortBisect(): Promise<void> {
    await this.run(GitCommand.bisectReset());
  }

  async cleanWorkingTree(): Promise<void> {
    await this.run(GitCommand.cleanForce());
  }

  async resetHard(ref: string): Promise<void> {
    await this.run(GitCommand.resetHard(ref));
  }

  async resetSoft(ref: string): Promise<void> {
    await this.run(GitCommand.resetSoft(ref));
  }

  async deleteBranch(branch: string): Promise<void> {
    await this.run(GitCommand.deleteBranch(branch));
  }

  async forcePushWithLease(): Promise<void> {
    await this.run(GitCommand.forcePushWithLease());
  }

  async revertCommit(ref: string): Promise<void> {
    await this.run(GitCommand.revertCommit(ref));
  }

  async commitNoEdit(): Promise<void> {
    await this.run(GitCommand.commitNoEdit());
  }

  async countCommitsBetween(from: string, to: string): Promise<number> {
    const output = await this.run(GitCommand.countCommitsBetween(from, to));
    return Number.parseInt(output.trim(), 10) || 0;
  }

  async listConflictedFiles(): Promise<string[]> {
    const output = await this.run(GitCommand.listConflictedFiles());
    return output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  }

  async conflictedFilesAreBinary(): Promise<Map<string, boolean>> {
    const output = await this.run(GitCommand.conflictedFilesNumstat());
    const result = new Map<string, boolean>();
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [added, deleted, ...pathParts] = trimmed.split("\t");
      result.set(pathParts.join("\t"), added === "-" && deleted === "-");
    }
    return result;
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
