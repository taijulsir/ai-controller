import path from "node:path";
import type { Repository } from "../domain/repository/Repository";
import { CONFIG_DIRECTORY, ConfigFileName } from "./ConfigConstants";
import type { IConfigService } from "./interfaces";
import { RepositoryMapper } from "./RepositoryMapper";
import type {
  ClaudeConfig,
  ControllerConfig,
  GithubConfig,
  TelegramConfig,
} from "./types";
import {
  validateClaudeConfig,
  validateControllerConfig,
  validateGithubConfig,
  validateRepositoriesConfig,
  validateTelegramConfig,
} from "./validators";
import { YamlConfigLoader } from "./YamlConfigLoader";

interface ConfigCache {
  controller?: ControllerConfig;
  claude?: ClaudeConfig;
  github?: GithubConfig;
  telegram?: TelegramConfig;
  repositories?: Repository[];
}

export class ConfigService implements IConfigService {
  private cache: ConfigCache = {};

  constructor(
    private readonly configDirectory: string = CONFIG_DIRECTORY,
    private readonly loader: YamlConfigLoader = new YamlConfigLoader(),
    private readonly repositoryMapper: RepositoryMapper = new RepositoryMapper(),
  ) {}

  getControllerConfig(): ControllerConfig {
    if (!this.cache.controller) {
      this.cache.controller = this.loadControllerConfig();
    }
    return this.cache.controller;
  }

  getClaudeConfig(): ClaudeConfig {
    if (!this.cache.claude) {
      this.cache.claude = this.loadClaudeConfig();
    }
    return this.cache.claude;
  }

  getGithubConfig(): GithubConfig {
    if (!this.cache.github) {
      this.cache.github = this.loadGithubConfig();
    }
    return this.cache.github;
  }

  getTelegramConfig(): TelegramConfig {
    if (!this.cache.telegram) {
      this.cache.telegram = this.loadTelegramConfig();
    }
    return this.cache.telegram;
  }

  getRepositories(): Repository[] {
    if (!this.cache.repositories) {
      this.cache.repositories = this.loadRepositories();
    }
    return this.cache.repositories;
  }

  reload(): void {
    this.cache = {
      controller: this.loadControllerConfig(),
      claude: this.loadClaudeConfig(),
      github: this.loadGithubConfig(),
      telegram: this.loadTelegramConfig(),
      repositories: this.loadRepositories(),
    };
  }

  private loadControllerConfig(): ControllerConfig {
    const filePath = this.resolvePath(ConfigFileName.Controller);
    return validateControllerConfig(this.loader.load(filePath), filePath);
  }

  private loadClaudeConfig(): ClaudeConfig {
    const filePath = this.resolvePath(ConfigFileName.Claude);
    return validateClaudeConfig(this.loader.load(filePath), filePath);
  }

  private loadGithubConfig(): GithubConfig {
    const filePath = this.resolvePath(ConfigFileName.Github);
    return validateGithubConfig(this.loader.load(filePath), filePath);
  }

  private loadTelegramConfig(): TelegramConfig {
    const filePath = this.resolvePath(ConfigFileName.Telegram);
    return validateTelegramConfig(this.loader.load(filePath), filePath);
  }

  private loadRepositories(): Repository[] {
    const filePath = this.resolvePath(ConfigFileName.Repositories);
    const raw = validateRepositoriesConfig(this.loader.load(filePath), filePath);
    return this.repositoryMapper.toDomain(raw);
  }

  private resolvePath(fileName: string): string {
    return path.join(this.configDirectory, fileName);
  }
}
