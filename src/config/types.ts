export interface ControllerConfig {
  controller: {
    name: string;
    version: string;
    environment: string;
  };

  workspace: {
    root: string;
  };

  task: {
    max_concurrent_jobs: number;
    timeout_minutes: number;
  };

  approval: {
    mode: string;
    require_before_git_push: boolean;
    require_before_pull_request: boolean;
  };

  logging: {
    enabled: boolean;
    level: string;
    directory: string;
  };

  memory: {
    enabled: boolean;
    directory: string;
  };
}

export interface ClaudeConfig {
  provider: {
    name: string;
  };

  cli: {
    executable: string;
  };

  execution: {
    approval_mode: string;
    max_execution_minutes: number;
  };

  session: {
    resume_previous: boolean;
  };
}

export interface GithubConfig {
  github: {
    cli: string;
  };

  git: {
    default_branch: string;
  };

  pull_request: {
    auto_create: boolean;
    auto_merge: boolean;
  };
}

export interface TelegramConfig {
  telegram: {
    enabled: boolean;
  };

  bot: {
    token: string;
  };

  security: {
    allowed_users: string[];
  };

  notifications: {
    task_started: boolean;
    task_completed: boolean;
    task_failed: boolean;
  };
}

export interface RepositoryEntry {
  name: string;
  path: string;
  default_branch?: string;
}

export interface RepositoriesFileConfig {
  repositories: Record<string, RepositoryEntry>;
  active_repository: string | null;
}
