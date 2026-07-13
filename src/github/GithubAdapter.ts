import type { IConfigService } from "../config/interfaces";
import type { Repository } from "../domain/repository/Repository";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import { GithubCommand } from "./GithubConstants";
import { GithubCommandRunner } from "./GithubCommandRunner";
import { NoActiveRepositoryError } from "./errors";
import type { IGithubAdapter } from "./interfaces";
import { PullRequestMapper } from "./PullRequestMapper";
import type { CreatePullRequestOptions, PullRequestSummary } from "./types";

export class GithubAdapter implements IGithubAdapter {
  constructor(
    private readonly configService: IConfigService,
    private readonly repositoryRegistry: IRepositoryRegistry,
    private readonly repositoryId?: string,
    private readonly commandRunner: GithubCommandRunner = new GithubCommandRunner(),
    private readonly mapper: PullRequestMapper = new PullRequestMapper(),
  ) {}

  getDefaultBaseBranch(): string {
    return this.configService.getGithubConfig().git.default_branch;
  }

  async createPullRequest(options: CreatePullRequestOptions): Promise<PullRequestSummary> {
    const repository = this.resolveRepository();
    const githubConfig = this.configService.getGithubConfig();
    const baseBranch = options.baseBranch ?? this.getDefaultBaseBranch();

    await this.commandRunner.run(
      githubConfig.github.cli,
      repository.path,
      GithubCommand.createPullRequest(options.title, baseBranch, options.body),
    );

    const output = await this.commandRunner.run(
      githubConfig.github.cli,
      repository.path,
      GithubCommand.viewCurrentPullRequest(),
    );

    return this.mapper.toDomain(output);
  }

  async listOpenPullRequests(): Promise<PullRequestSummary[]> {
    const repository = this.resolveRepository();
    const githubConfig = this.configService.getGithubConfig();

    const output = await this.commandRunner.run(
      githubConfig.github.cli,
      repository.path,
      GithubCommand.listOpenPullRequests(),
    );

    return this.mapper.toDomainList(output);
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
