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

// Exported so ResponseFormatter can recognize this exact outcome (to render
// "Cancelled" instead of "Failed") without duplicating the literal string or
// resorting to fragile substring matching -- the message itself is still
// entirely owned here, ResponseFormatter only ever compares against it.
export const TASK_CANCELLED_MESSAGE = "Task was cancelled.";

// Distinct from TaskTimeoutError even though both surface via the same
// AbortController/Promise.race machinery in TaskPlanner: this one is thrown
// only when TaskPlanner.cancel() explicitly aborted the controller (an
// AbortSignal "reason" TaskPlanner itself set), never when the timeout timer
// fired one with no reason -- so the eventual TaskResult.error a user sees
// accurately says "cancelled", not "timed out".
export class TaskCancelledError extends Error {
  constructor() {
    super(TASK_CANCELLED_MESSAGE);
    this.name = "TaskCancelledError";
  }
}

export class PullRequestBaseBranchConflictError extends Error {
  constructor(branch: string) {
    super(
      `Cannot create a pull request from "${branch}" because it is the configured base branch. Check out a feature branch first.`,
    );
    this.name = "PullRequestBaseBranchConflictError";
  }
}

export class TaskCancellerNotBoundError extends Error {
  constructor() {
    super("DeferredTaskCanceller.cancel() was called before bind() wired it to the real TaskPlanner.");
    this.name = "TaskCancellerNotBoundError";
  }
}

// Deviation from the Phase 0 freeze, noted in the implementation report:
// UnsafeBranchSwitchError, UnsafeGitOperationError, DetachedHeadError,
// DivergedBranchError, SameBranchMergeError, and MergeConflictError were
// removed from here during the git-orchestration retrofit. Every one was a
// workflow's own hand-rolled precondition/conflict check, now replaced
// uniformly by Pre-flight Validation Policy (PreflightValidationFailedError,
// src/gitorchestration/errors.ts) and the Engines' own ConflictReport-based
// outcomes -- exactly the "replace duplicated validation with the new
// validation layer" requirement, not a stylistic removal. Confirmed unused
// (grep across src/) before deletion.

// Thrown only when /rebase is given no explicit target and the branch also
// has no configured upstream to default to -- SyncWorkflow's "@{upstream}"
// shorthand has the same failure mode, but lets git itself produce the
// error; RebaseWorkflow checks explicitly instead, since IGitAdapter.rebase()
// takes a resolved ref, not git's own "@{upstream}" shorthand.
export class NoUpstreamConfiguredError extends Error {
  constructor(branch: string) {
    super(`Cannot rebase "${branch}": no target was given and it has no configured upstream to default to.`);
    this.name = "NoUpstreamConfiguredError";
  }
}
