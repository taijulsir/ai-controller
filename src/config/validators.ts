import { ConfigValidationError } from "./errors";
import type {
  ClaudeConfig,
  ControllerConfig,
  GithubConfig,
  RepositoriesFileConfig,
  TelegramConfig,
} from "./types";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && !Number.isNaN(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function fail(filePath: string, issues: string[]): never {
  throw new ConfigValidationError(filePath, issues);
}

export function validateControllerConfig(
  data: unknown,
  filePath: string,
): ControllerConfig {
  if (!isObject(data)) fail(filePath, ['root value must be an object']);

  const issues: string[] = [];

  const controller = data.controller;
  if (!isObject(controller)) {
    issues.push('"controller" section is missing or invalid');
  } else {
    if (!isString(controller.name)) issues.push('"controller.name" must be a string');
    if (!isString(controller.version)) issues.push('"controller.version" must be a string');
    if (!isString(controller.environment)) issues.push('"controller.environment" must be a string');
  }

  const workspace = data.workspace;
  if (!isObject(workspace)) {
    issues.push('"workspace" section is missing or invalid');
  } else if (!isString(workspace.root)) {
    issues.push('"workspace.root" must be a string');
  }

  const task = data.task;
  if (!isObject(task)) {
    issues.push('"task" section is missing or invalid');
  } else {
    if (!isNumber(task.max_concurrent_jobs)) issues.push('"task.max_concurrent_jobs" must be a number');
    if (!isNumber(task.timeout_minutes)) issues.push('"task.timeout_minutes" must be a number');
  }

  const approval = data.approval;
  if (!isObject(approval)) {
    issues.push('"approval" section is missing or invalid');
  } else {
    if (!isString(approval.mode)) issues.push('"approval.mode" must be a string');
    if (!isBoolean(approval.require_before_git_push)) issues.push('"approval.require_before_git_push" must be a boolean');
    if (!isBoolean(approval.require_before_pull_request)) issues.push('"approval.require_before_pull_request" must be a boolean');
  }

  const logging = data.logging;
  if (!isObject(logging)) {
    issues.push('"logging" section is missing or invalid');
  } else {
    if (!isBoolean(logging.enabled)) issues.push('"logging.enabled" must be a boolean');
    if (!isString(logging.level)) issues.push('"logging.level" must be a string');
    if (!isString(logging.directory)) issues.push('"logging.directory" must be a string');
  }

  const memory = data.memory;
  if (!isObject(memory)) {
    issues.push('"memory" section is missing or invalid');
  } else {
    if (!isBoolean(memory.enabled)) issues.push('"memory.enabled" must be a boolean');
    if (!isString(memory.directory)) issues.push('"memory.directory" must be a string');
  }

  if (issues.length > 0) fail(filePath, issues);

  return data as unknown as ControllerConfig;
}

export function validateClaudeConfig(data: unknown, filePath: string): ClaudeConfig {
  if (!isObject(data)) fail(filePath, ['root value must be an object']);

  const issues: string[] = [];

  const provider = data.provider;
  if (!isObject(provider)) {
    issues.push('"provider" section is missing or invalid');
  } else if (!isString(provider.name)) {
    issues.push('"provider.name" must be a string');
  }

  const cli = data.cli;
  if (!isObject(cli)) {
    issues.push('"cli" section is missing or invalid');
  } else if (!isString(cli.executable)) {
    issues.push('"cli.executable" must be a string');
  }

  const execution = data.execution;
  if (!isObject(execution)) {
    issues.push('"execution" section is missing or invalid');
  } else {
    if (!isString(execution.approval_mode)) issues.push('"execution.approval_mode" must be a string');
    if (!isNumber(execution.max_execution_minutes)) issues.push('"execution.max_execution_minutes" must be a number');
  }

  const session = data.session;
  if (!isObject(session)) {
    issues.push('"session" section is missing or invalid');
  } else if (!isBoolean(session.resume_previous)) {
    issues.push('"session.resume_previous" must be a boolean');
  }

  if (issues.length > 0) fail(filePath, issues);

  return data as unknown as ClaudeConfig;
}

export function validateGithubConfig(data: unknown, filePath: string): GithubConfig {
  if (!isObject(data)) fail(filePath, ['root value must be an object']);

  const issues: string[] = [];

  const github = data.github;
  if (!isObject(github)) {
    issues.push('"github" section is missing or invalid');
  } else if (!isString(github.cli)) {
    issues.push('"github.cli" must be a string');
  }

  const git = data.git;
  if (!isObject(git)) {
    issues.push('"git" section is missing or invalid');
  } else if (!isString(git.default_branch)) {
    issues.push('"git.default_branch" must be a string');
  }

  const pullRequest = data.pull_request;
  if (!isObject(pullRequest)) {
    issues.push('"pull_request" section is missing or invalid');
  } else {
    if (!isBoolean(pullRequest.auto_create)) issues.push('"pull_request.auto_create" must be a boolean');
    if (!isBoolean(pullRequest.auto_merge)) issues.push('"pull_request.auto_merge" must be a boolean');
  }

  if (issues.length > 0) fail(filePath, issues);

  return data as unknown as GithubConfig;
}

export function validateTelegramConfig(data: unknown, filePath: string): TelegramConfig {
  if (!isObject(data)) fail(filePath, ['root value must be an object']);

  const issues: string[] = [];

  const telegram = data.telegram;
  if (!isObject(telegram)) {
    issues.push('"telegram" section is missing or invalid');
  } else {
    if (!isBoolean(telegram.enabled)) issues.push('"telegram.enabled" must be a boolean');
    // Phase 14: optional -- only validated when present, absence is valid
    // and means Phase 13's fail-closed behavior is unchanged.
    if (telegram.operator_chat_id !== undefined && !isNumber(telegram.operator_chat_id)) {
      issues.push('"telegram.operator_chat_id" must be a number when present');
    }
  }

  const bot = data.bot;
  if (!isObject(bot)) {
    issues.push('"bot" section is missing or invalid');
  } else if (!isString(bot.token)) {
    issues.push('"bot.token" must be a string');
  }

  const security = data.security;
  if (!isObject(security)) {
    issues.push('"security" section is missing or invalid');
  } else if (!isStringArray(security.allowed_users)) {
    issues.push('"security.allowed_users" must be an array of strings');
  }

  const notifications = data.notifications;
  if (!isObject(notifications)) {
    issues.push('"notifications" section is missing or invalid');
  } else {
    if (!isBoolean(notifications.task_started)) issues.push('"notifications.task_started" must be a boolean');
    if (!isBoolean(notifications.task_completed)) issues.push('"notifications.task_completed" must be a boolean');
    if (!isBoolean(notifications.task_failed)) issues.push('"notifications.task_failed" must be a boolean');
  }

  if (issues.length > 0) fail(filePath, issues);

  return data as unknown as TelegramConfig;
}

export function validateRepositoriesConfig(
  data: unknown,
  filePath: string,
): RepositoriesFileConfig {
  if (!isObject(data)) fail(filePath, ['root value must be an object']);

  const issues: string[] = [];

  const repositories = data.repositories;
  if (!isObject(repositories)) {
    issues.push('"repositories" section is missing or invalid');
  } else {
    for (const [id, entry] of Object.entries(repositories)) {
      if (!isObject(entry)) {
        issues.push(`repository "${id}" must be an object`);
        continue;
      }
      if (!isString(entry.name)) issues.push(`repository "${id}.name" must be a string`);
      if (!isString(entry.path)) issues.push(`repository "${id}.path" must be a string`);
      if (entry.default_branch !== undefined && !isString(entry.default_branch)) {
        issues.push(`repository "${id}.default_branch" must be a string when provided`);
      }
    }
  }

  const activeRepository = data.active_repository;
  if (activeRepository !== null && !isString(activeRepository)) {
    issues.push('"active_repository" must be a string or null');
  }

  if (issues.length > 0) fail(filePath, issues);

  return data as unknown as RepositoriesFileConfig;
}
