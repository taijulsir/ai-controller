import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IConfigService } from "../src/config/interfaces";
import type {
  ClaudeConfig,
  ControllerConfig,
  GithubConfig,
  TelegramConfig,
} from "../src/config/types";
import type { Repository } from "../src/domain/repository/Repository";
import {
  NotAGitRepositoryError,
  RepositoryNotFoundError,
  RepositoryPathNotFoundError,
} from "../src/repositories/errors";
import { RepositoryRegistry } from "../src/repositories/RepositoryRegistry";

class FakeConfigService implements IConfigService {
  constructor(private readonly repositories: Repository[]) {}

  getControllerConfig(): ControllerConfig {
    throw new Error("not used in this verification script");
  }
  getClaudeConfig(): ClaudeConfig {
    throw new Error("not used in this verification script");
  }
  getGithubConfig(): GithubConfig {
    throw new Error("not used in this verification script");
  }
  getTelegramConfig(): TelegramConfig {
    throw new Error("not used in this verification script");
  }
  getRepositories(): Repository[] {
    return this.repositories;
  }
  reload(): void {}
}

function createFakeRepo(id: string, withGit: boolean, active = false): Repository {
  const repoPath = mkdtempSync(path.join(tmpdir(), `${id}-`));
  if (withGit) {
    mkdirSync(path.join(repoPath, ".git"));
  }
  return { id, name: id, path: repoPath, defaultBranch: "main", active };
}

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

function main(): void {
  const alpha = createFakeRepo("alpha", true, true);
  const beta = createFakeRepo("beta", true);
  const tempPaths = [alpha.path, beta.path];

  try {
    const configService = new FakeConfigService([alpha, beta]);
    const registry = new RepositoryRegistry(configService);

    assert(
      registry.getAllRepositories().map((r) => r.id).join(",") === "alpha,beta",
      "getAllRepositories() returns all registered repositories",
    );
    assert(
      registry.getActiveRepository()?.id === "alpha",
      "getActiveRepository() reflects active_repository from config",
    );
    assert(registry.repositoryExists("beta"), "repositoryExists() true for known id");
    assert(!registry.repositoryExists("missing"), "repositoryExists() false for unknown id");

    registry.setActiveRepository("beta");
    assert(
      registry.getActiveRepository()?.id === "beta",
      "setActiveRepository() switches the active repository",
    );

    try {
      registry.getRepository("missing");
      assert(false, "getRepository() throws RepositoryNotFoundError for unknown id");
    } catch (error) {
      assert(
        error instanceof RepositoryNotFoundError,
        "getRepository() throws RepositoryNotFoundError for unknown id",
      );
    }

    try {
      registry.setActiveRepository("missing");
      assert(false, "setActiveRepository() throws RepositoryNotFoundError for unknown id");
    } catch (error) {
      assert(
        error instanceof RepositoryNotFoundError,
        "setActiveRepository() throws RepositoryNotFoundError for unknown id",
      );
    }

    registry.refresh();
    assert(
      registry.getActiveRepository()?.id === "alpha",
      "refresh() rebuilds state from config, config remains source of truth for active repo",
    );

    const missingPathRepo = createFakeRepo("gamma", true);
    rmSync(missingPathRepo.path, { recursive: true, force: true });
    try {
      new RepositoryRegistry(new FakeConfigService([missingPathRepo])).getAllRepositories();
      assert(false, "validator throws RepositoryPathNotFoundError for missing path");
    } catch (error) {
      assert(
        error instanceof RepositoryPathNotFoundError,
        "validator throws RepositoryPathNotFoundError for missing path",
      );
    }

    const notGitRepo = createFakeRepo("delta", false);
    tempPaths.push(notGitRepo.path);
    try {
      new RepositoryRegistry(new FakeConfigService([notGitRepo])).getAllRepositories();
      assert(false, "validator throws NotAGitRepositoryError when .git is missing");
    } catch (error) {
      assert(
        error instanceof NotAGitRepositoryError,
        "validator throws NotAGitRepositoryError when .git is missing",
      );
    }
  } finally {
    for (const tempPath of tempPaths) {
      rmSync(tempPath, { recursive: true, force: true });
    }
  }
}

main();
