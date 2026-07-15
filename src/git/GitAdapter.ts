import type { Repository } from "../domain/repository/Repository";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import { GitCommandRunner } from "./GitCommandRunner";
import { DEFAULT_RECENT_COMMITS_LIMIT, GitCommand } from "./GitConstants";
import { NoActiveRepositoryError } from "./errors";
import { parseGitLog } from "./GitLogParser";
import { parseGitStatus } from "./GitStatusParser";
import type { IGitAdapter } from "./interfaces";
import type { CommitSummary, GitStatus } from "./types";

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

  async pull(): Promise<void> {
    await this.run(GitCommand.pull());
  }

  async getRecentCommits(limit: number = DEFAULT_RECENT_COMMITS_LIMIT): Promise<CommitSummary[]> {
    const output = await this.run(GitCommand.recentCommits(limit));
    return parseGitLog(output);
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
