import type { Repository } from "../domain/repository/Repository";
import type { RepositoriesFileConfig } from "./types";

const DEFAULT_BRANCH_FALLBACK = "main";

export class RepositoryMapper {
  toDomain(config: RepositoriesFileConfig): Repository[] {
    return Object.entries(config.repositories).map(([id, entry]) => ({
      id,
      name: entry.name,
      path: entry.path,
      defaultBranch: entry.default_branch ?? DEFAULT_BRANCH_FALLBACK,
      active: id === config.active_repository,
    }));
  }
}
