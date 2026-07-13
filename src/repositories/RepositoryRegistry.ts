import type { IConfigService } from "../config/interfaces";
import type { Repository } from "../domain/repository/Repository";
import { RepositoryNotFoundError } from "./errors";
import type { IRepositoryRegistry } from "./interfaces";
import { RepositoryValidator } from "./RepositoryValidator";

export class RepositoryRegistry implements IRepositoryRegistry {
  private repositories?: Map<string, Repository>;
  private activeId?: string;

  constructor(
    private readonly configService: IConfigService,
    private readonly validator: RepositoryValidator = new RepositoryValidator(),
  ) {}

  getAllRepositories(): Repository[] {
    return Array.from(this.ensureLoaded().values());
  }

  getRepository(id: string): Repository {
    const repository = this.ensureLoaded().get(id);
    if (!repository) {
      throw new RepositoryNotFoundError(id);
    }
    return repository;
  }

  getActiveRepository(): Repository | undefined {
    const repositories = this.ensureLoaded();
    return this.activeId ? repositories.get(this.activeId) : undefined;
  }

  setActiveRepository(id: string): void {
    if (!this.ensureLoaded().has(id)) {
      throw new RepositoryNotFoundError(id);
    }
    this.activeId = id;
  }

  repositoryExists(id: string): boolean {
    return this.ensureLoaded().has(id);
  }

  refresh(): void {
    this.load();
  }

  private ensureLoaded(): Map<string, Repository> {
    if (!this.repositories) {
      this.load();
    }
    return this.repositories!;
  }

  private load(): void {
    const repositories = this.configService.getRepositories();
    for (const repository of repositories) {
      this.validator.validate(repository);
    }

    this.repositories = new Map(repositories.map((repository) => [repository.id, repository]));
    this.activeId = repositories.find((repository) => repository.active)?.id;
  }
}
