import type { ExecutionResult } from "../controller/types";
import type { TaskType } from "../planner/types";

// "undo" is appended by UndoService itself (via ProjectMemoryService.recordUndo()),
// never produced by MemoryRecordingControllerCore -- undoing isn't an
// ExecutionRequest passing through ControllerCore, it's a direct, targeted
// git operation, the same way /task cancel directly reaches TaskPlanner
// without going through ControllerCore either. Recorded as one more append
// to the same history file (never a mutation of the original execution's own
// event) so "was this checkpoint already undone" stays a pure read-time scan
// over an append-only log, exactly like everything else this file already
// stores.
//
// Repository Failure Policy redesign: "failure-state-cleared" is appended by
// ProjectMemoryService.clearFailureState()/clearAllFailureStates() (the
// /clear-failures Telegram command), the same "one more append, never a
// mutation of any prior event" discipline as "undo" above. taskType is
// undefined for "cleared every task type at once" (one event, not N) --
// mirrors how "discard-all" is one outcome, not one per file.
export type ProjectMemoryOutcome =
  | { kind: "result"; result: ExecutionResult }
  | { kind: "error"; error: string }
  | { kind: "undo"; undoneCheckpointId: string }
  | { kind: "failure-state-cleared"; taskType?: TaskType };

export interface ProjectMemoryEvent {
  id: string;
  recordedAt: Date;
  repositoryId?: string;
  outcome: ProjectMemoryOutcome;
}

// Repository Failure Policy redesign: persisted per (repositoryId, taskType)
// consecutive-failure counter, stored separately from the append-only event
// log above (see ProjectMemoryService's failure-state.json). "blocked" is
// always derived from consecutiveFailures at the single point a record is
// written -- never set independently by a caller -- so it can never drift
// out of sync with the count it's supposed to reflect.
export interface TaskFailureState {
  repositoryId: string;
  taskType: TaskType;
  consecutiveFailures: number;
  lastFailure?: Date;
  lastSuccess?: Date;
  blocked: boolean;
}

// /failures' own per-task-type view: TaskFailureState plus a status label
// precomputed once, in ApplicationService.getFailureStatus, from
// DecisionEngine's exported threshold constants -- so ResponseFormatter
// never needs its own copy of the warning/block numbers to render "BLOCKED"/
// "WARNING"/"Healthy".
export interface TaskFailureStatus extends TaskFailureState {
  status: "blocked" | "warning" | "healthy";
}

// /clear-failures' result -- taskType undefined means "cleared every task
// type for this repository" (mirrors the same field on the
// "failure-state-cleared" ProjectMemoryOutcome and the "clear-failures"
// ApplicationQuery above).
export interface FailureClearResult {
  repositoryId: string;
  taskType?: TaskType;
}
