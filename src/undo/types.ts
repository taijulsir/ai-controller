import type { JournalOperationType, JournalRollbackStrategy } from "../journal/types";
import type { TaskType } from "../planner/types";

export type UndoPlanStatus = "ready" | "nothing-to-undo" | "execution-in-progress" | "drift-detected";

// Phase 1's output: an immutable, plain-data description of what /undo would
// do, computed once and never mutated afterward -- built and (for the
// "ready" case) executed back-to-back with no gap today, but the split
// itself is what leaves room for a future gap (a preview command, a
// confirmation round-trip) without redesigning either phase. A caller that
// introduces such a gap must rebuild the plan immediately before executing
// it rather than reusing a possibly-stale one -- canUndo/conflictingFiles
// describe the repository's state at build time, not at whatever later
// moment execution might happen.
export interface UndoPlan {
  status: UndoPlanStatus;
  canUndo: boolean;
  repositoryId: string;
  checkpointId?: string;
  correlationId?: string;
  taskType?: TaskType;
  // Paths that existed in the checkpoint's beforeSnapshot -- restoring means
  // checking their old content back out.
  filesToRestore: string[];
  // Paths that did not exist in beforeSnapshot -- restoring means deleting
  // them, since no checkout/restore invocation can express "this path should
  // not exist".
  filesToDelete: string[];
  // Non-empty only when status === "drift-detected": paths this execution
  // changed that no longer match its own recorded afterSnapshot, meaning
  // something else (a manual edit, a later execution) touched them since --
  // undoing anyway would silently destroy that unrelated change.
  conflictingFiles: string[];
  // Present only when status === "ready" -- needed by executeUndoPlan() to
  // actually perform the restore. Not meant for display; ResponseFormatter
  // never reads this field.
  beforeSnapshot?: string;
  // Present whenever a checkpoint was found (drift-detected/ready), absent
  // for nothing-to-undo/execution-in-progress. /undo's single command
  // surface (ApplicationService.undoLastExecution()) compares this against
  // GitUndoPlan.recordedAt below to decide which of the two undo mechanisms
  // -- this tree-content one, or Safe Undo Framework's ref-based one -- is
  // actually the most recent undoable thing for the repository.
  capturedAt?: Date;
}

// The ref-based sibling to UndoPlan above -- reverses a git-native mutation
// via the Operation Journal, not a Claude-editing task's tree snapshot.
// `strategy` reuses JournalRollbackStrategy directly (see its doc comment in
// src/journal/types.ts) rather than a second, parallel enum: the mechanism
// that undoes a given JournalEntry is always exactly the one it was
// recorded with, read straight off the entry, never re-derived from its
// operation type.
export interface GitUndoPlan {
  journalEntryId: string;
  operation: JournalOperationType;
  strategy: JournalRollbackStrategy;
  // true whenever the operation already reached the remote (a push) -- the
  // one case Safe Undo Framework refuses to act on without explicit approval.
  requiresApproval: boolean;
  // The JournalEntry's own completedAt (or startedAt, for the rare case a
  // completed entry somehow has no completedAt) -- the git-native sibling of
  // UndoPlan.capturedAt above, compared against it to decide which undo
  // mechanism actually reflects the repository's most recent change.
  recordedAt: Date;
}

export type UndoOutcome =
  | { kind: "nothing-to-undo" }
  | { kind: "execution-in-progress" }
  | { kind: "drift-detected"; checkpointId: string; taskType: TaskType; conflictingFiles: string[] }
  | { kind: "undone"; checkpointId: string; taskType: TaskType; restoredFiles: string[]; deletedFiles: string[] }
  // /undo's git-native outcome, produced when Safe Undo Framework's plan was
  // the more recent of the two (see ApplicationService.undoLastExecution()).
  | { kind: "git-undone"; operation: JournalOperationType };
