export class RepositoryNotFoundError extends Error {
  constructor(id: string) {
    super(`Repository "${id}" is not registered.`);
    this.name = "RepositoryNotFoundError";
  }
}

export class RepositoryPathNotFoundError extends Error {
  constructor(id: string, repoPath: string) {
    super(`Repository "${id}" points to a path that does not exist: "${repoPath}".`);
    this.name = "RepositoryPathNotFoundError";
  }
}

export class NotAGitRepositoryError extends Error {
  constructor(id: string, repoPath: string) {
    super(`Repository "${id}" at "${repoPath}" is not a Git repository (no .git directory found).`);
    this.name = "NotAGitRepositoryError";
  }
}
