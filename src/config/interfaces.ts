import type { Repository } from "../domain/repository/Repository";
import type {
  ClaudeConfig,
  ControllerConfig,
  GithubConfig,
  TelegramConfig,
} from "./types";

export interface IConfigService {
  getControllerConfig(): ControllerConfig;
  getClaudeConfig(): ClaudeConfig;
  getGithubConfig(): GithubConfig;
  getTelegramConfig(): TelegramConfig;
  getRepositories(): Repository[];
  reload(): void;
}
