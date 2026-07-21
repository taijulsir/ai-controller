import type { ExecutionResult } from "../controller/types";

// "undo" is appended by UndoService itself (via ProjectMemoryService.recordUndo()),
// never produced by MemoryRecordingControllerCore -- undoing isn't an
// ExecutionRequest passing through ControllerCore, it's a direct, targeted
// git operation, the same way /task cancel directly reaches TaskPlanner
// without going through ControllerCore either. Recorded as one more append
// to the same history file (never a mutation of the original execution's own
// event) so "was this checkpoint already undone" stays a pure read-time scan
// over an append-only log, exactly like everything else this file already
// stores.
export type ProjectMemoryOutcome =
  | { kind: "result"; result: ExecutionResult }
  | { kind: "error"; error: string }
  | { kind: "undo"; undoneCheckpointId: string };

export interface ProjectMemoryEvent {
  id: string;
  recordedAt: Date;
  repositoryId?: string;
  outcome: ProjectMemoryOutcome;
}
