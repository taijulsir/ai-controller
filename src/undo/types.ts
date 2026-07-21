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
}

export type UndoOutcome =
  | { kind: "nothing-to-undo" }
  | { kind: "execution-in-progress" }
  | { kind: "drift-detected"; checkpointId: string; taskType: TaskType; conflictingFiles: string[] }
  | { kind: "undone"; checkpointId: string; taskType: TaskType; restoredFiles: string[]; deletedFiles: string[] };
