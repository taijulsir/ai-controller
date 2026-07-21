import type { ITaskCancellationPolicy } from "./interfaces";
import type { TaskType } from "./types";

// Positive allowlist, not a "denylist of git ops": these are the task types
// actually bound to a long-running Claude subprocess, which is the one thing
// this codebase can currently interrupt in a way that stops real work rather
// than just changing a return value (see ClaudeAdapter's AbortSignal wiring).
// git/GitHub-bound task types (create-commit, push-changes,
// create-pull-request, switch-branch, create-branch, list-pull-requests,
// verify-git-status) are deliberately absent -- not because cancellation is
// hard-coded against "Git operations", but because nothing downstream of
// them currently observes an abort signal, so pretending to cancel one would
// either do nothing or (worse) leave the user unsure whether a push/PR
// actually completed. Extending this set later (e.g. once GitCommandRunner
// is wired to its own AbortSignal) is a one-line addition here -- it never
// requires touching TaskPlanner, ApplicationService, or /task cancel itself.
const CANCELLABLE_TASK_TYPES: ReadonlySet<TaskType> = new Set([
  "analyze-repository",
  "explain-code",
  "implement-feature",
  "fix-bug",
  "review-code",
]);

export class TaskCancellationPolicy implements ITaskCancellationPolicy {
  canCancel(taskType: TaskType): boolean {
    return CANCELLABLE_TASK_TYPES.has(taskType);
  }
}
