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
    // Legacy, per-command fields -- still fully validated and honored when
    // require_before (below) is absent, so any existing config/controller.yaml
    // that predates require_before keeps working completely unchanged.
    // Superseded (never consulted by ApprovalPolicy) once require_before is
    // present, even if these are also present.
    require_before_git_push?: boolean;
    require_before_pull_request?: boolean;
    // Generic replacement: any Task["type"] string (e.g. "push-changes",
    // "merge") can be listed here without ever touching this type, the
    // validator, or ApprovalPolicy again for a newly-introduced command.
    // Optional so existing configs need not adopt it.
    require_before?: string[];
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
    // Phase 14: optional. When present, the composition root builds one
    // fixed, opaque correlationId from it at startup (via the existing
    // Telegram correlation builder) and hands it to AutonomousExecutionWorker,
    // so an autonomous approval-gated execution attempt can reach this real
    // chat instead of always failing closed. When absent, Phase 13's
    // fail-closed behavior is unchanged.
    operator_chat_id?: number;
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
