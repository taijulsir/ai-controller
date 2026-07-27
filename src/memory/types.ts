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

// Failure State Self-Healing: current on-disk schema version for
// failure-state.json. Bump this, and add a migration branch in
// ProjectMemoryService's own validation, the day this envelope's shape ever
// needs to change -- until then, any file whose schemaVersion doesn't match
// this exact number is treated as a schema mismatch and rebuilt from
// Project Memory history, never partially trusted.
export const FAILURE_STATE_SCHEMA_VERSION = 1;

// The on-disk envelope for failure-state.json, replacing the old bare
// Record<repositoryId, Record<taskType, TaskFailureState>> map with one that
// carries its own metadata -- schemaVersion (so a future format change can
// be detected instead of silently misread) and updatedAt (so an operator
// inspecting the file on disk can see when it was last written without
// cross-referencing events.jsonl). Each TaskFailureState entry already
// carries its own repositoryId/taskType fields, so per-record identity
// doesn't need to be duplicated again at the envelope level.
export interface FailureStateFile {
  schemaVersion: number;
  updatedAt: Date;
  repositories: Record<string, Record<string, TaskFailureState>>;
}

// Result of ProjectMemoryService.validateAndRepairFailureState(), the
// startup-time self-healing check -- logged by the composition root the same
// way EnvironmentValidator's report is (see src/startup/), never thrown.
export interface FailureStateValidationReport {
  status: "valid" | "rebuilt" | "skipped-memory-disabled";
  // Only set when status is "rebuilt" -- why the on-disk file couldn't be
  // trusted as-is.
  reason?: "missing" | "invalid-json" | "schema-mismatch";
  // Only set when status is "rebuilt" -- how many repositories had at least
  // one task type's state recovered from Project Memory history.
  repositoriesRecovered?: number;
}
