import type { IUndoableTaskPolicy } from "./interfaces";
import type { TaskType } from "./types";

// Positive allowlist, same reasoning as TaskCancellationPolicy's own: these
// are the task types where Claude edits repository files directly. Every
// other task type either never touches files (analyze-repository,
// explain-code, review-code, list-pull-requests, verify-git-status) or
// mutates the repository through a fully deterministic, user-initiated git
// operation the user already invoked directly (create-commit, push-changes,
// create-pull-request, switch-branch, create-branch) -- reverting one of
// those is a distinct concern from "undo the AI's last edit" and explicitly
// out of scope for /undo. Extending this set later (e.g. a future task type
// that also lets Claude write files) is a one-line addition here.
const UNDOABLE_TASK_TYPES: ReadonlySet<TaskType> = new Set(["implement-feature", "fix-bug"]);

export class UndoableTaskPolicy implements IUndoableTaskPolicy {
  isUndoable(taskType: TaskType): boolean {
    return UNDOABLE_TASK_TYPES.has(taskType);
  }
}
