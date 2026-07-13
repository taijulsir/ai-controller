import { existsSync } from "node:fs";
import path from "node:path";
import type { Repository } from "../domain/repository/Repository";
import { NotAGitRepositoryError, RepositoryPathNotFoundError } from "./errors";

export class RepositoryValidator {
  validate(repository: Repository): void {
    if (!existsSync(repository.path)) {
      throw new RepositoryPathNotFoundError(repository.id, repository.path);
    }

    const gitDirectory = path.join(repository.path, ".git");
    if (!existsSync(gitDirectory)) {
      throw new NotAGitRepositoryError(repository.id, repository.path);
    }
  }
}
