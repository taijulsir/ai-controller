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

export class UnsafeBranchSwitchError extends Error {
  constructor(branch: string, staged: number, unstaged: number, untracked: number) {
    super(
      `Cannot switch to "${branch}": the working tree has uncommitted changes ` +
        `(${staged} staged, ${unstaged} unstaged, ${untracked} untracked). Commit or discard them first.`,
    );
    this.name = "UnsafeBranchSwitchError";
  }
}

// Phase D (Git Operations) -- SyncWorkflow/MergeWorkflow's own safety checks,
// same reasoning as UnsafeBranchSwitchError above: reads GitStatus.isClean
// itself, before attempting anything, rather than depending on git's own
// refusal or discovering a conflict mid-operation.
export class UnsafeGitOperationError extends Error {
  constructor(operation: string, staged: number, unstaged: number, untracked: number) {
    super(
      `Cannot ${operation}: the working tree has uncommitted changes ` +
        `(${staged} staged, ${unstaged} unstaged, ${untracked} untracked). Commit or discard them first.`,
    );
    this.name = "UnsafeGitOperationError";
  }
}

export class DetachedHeadError extends Error {
  constructor(operation: string) {
    super(`Cannot ${operation}: HEAD is detached, not on a branch.`);
    this.name = "DetachedHeadError";
  }
}

// /sync's own deliberate limit: it only ever fast-forwards or refuses, never
// creates a merge commit -- when the local branch and its upstream have
// genuinely diverged, this is thrown to redirect the user to the explicit,
// conflict-aware /merge instead of silently doing something more complex.
export class DivergedBranchError extends Error {
  constructor(branch: string) {
    super(`Cannot sync "${branch}": it has diverged from its upstream. Use /merge to merge deliberately.`);
    this.name = "DivergedBranchError";
  }
}

export class SameBranchMergeError extends Error {
  constructor(branch: string) {
    super(`Cannot merge "${branch}" into itself.`);
    this.name = "SameBranchMergeError";
  }
}

// Thrown only after MergeWorkflow has already run `git merge --abort` --
// the repository is guaranteed back in its pre-merge state by the time a
// caller ever sees this, never left with conflict markers or a
// half-finished merge.
export class MergeConflictError extends Error {
  constructor(sourceBranch: string, targetBranch: string) {
    super(`Merging "${sourceBranch}" into "${targetBranch}" produced conflicts. The merge was aborted; nothing was changed.`);
    this.name = "MergeConflictError";
  }
}
