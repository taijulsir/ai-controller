export class UnknownTaskTypeError extends Error {
  constructor(taskType: string) {
    super(`No workflow is registered for task type "${taskType}".`);
    this.name = "UnknownTaskTypeError";
  }
}

export class TaskConcurrencyLimitExceededError extends Error {
  constructor(limit: number) {
    super(`Cannot start a new task: the concurrency limit of ${limit} concurrent job(s) has been reached.`);
    this.name = "TaskConcurrencyLimitExceededError";
  }
}

export class MissingTaskInputError extends Error {
  constructor(taskType: string, field: string) {
    super(`Task "${taskType}" is missing required input field "${field}".`);
    this.name = "MissingTaskInputError";
  }
}

export class TaskTimeoutError extends Error {
  constructor(taskType: string, timeoutMinutes: number) {
    super(`Task "${taskType}" exceeded the configured timeout of ${timeoutMinutes} minute(s).`);
    this.name = "TaskTimeoutError";
  }
}
