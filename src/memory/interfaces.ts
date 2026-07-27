import type { ExecutionRequest } from "../controller/types";
import type { ExecutionCheckpoint, TaskType } from "../planner/types";
import type { ProjectMemoryEvent, ProjectMemoryOutcome, TaskFailureState } from "./types";

// Phase 13: the narrow, read-only view of IProjectMemoryService's history
// query, carved out specifically for AutonomousExecutionWorker
// (src/runtime/AutonomousExecutionWorker.ts) — so that worker's history
// dependency is capable of nothing except reading recent events, never
// record(). The worker must never call record() itself: every execution it
// triggers already gets recorded automatically by MemoryRecordingControllerCore,
// further up the existing ControllerCore stack; a worker able to call
// record() directly could produce a second, duplicate, or conflicting entry
// for the same attempt. ProjectMemoryService requires no change to satisfy
// this — it already implements a method with this exact name and signature,
// and IProjectMemoryService below extends this interface rather than
// redeclaring the method.
export interface IRecentExecutionHistoryProvider {
  getRecentEvents(options?: { repositoryId?: string; limit?: number }): Promise<ProjectMemoryEvent[]>;
}

// Phase B (Undo): narrow read view over the same history stream
// getRecentEvents() already exposes -- carved out for UndoService the same
// way IRecentExecutionHistoryProvider is carved out for AutonomousExecutionWorker,
// so its dependency is capable of nothing except this one lookup, never
// record() (which would let it fabricate a fake execution history entry) or
// recordUndo() below (a different write, deliberately not given to a read
// consumer). Skips any undoable checkpoint already followed, later in the
// same append-ordered history, by an "undo" event referencing its own id --
// a pure read-time computation over already-stored data, never a second
// store.
export interface IUndoableExecutionHistoryProvider {
  getMostRecentUndoableExecution(repositoryId: string): Promise<ExecutionCheckpoint | undefined>;
}

// Phase B (Undo): the one write UndoService needs, carved out separately
// from record() above -- appends the "undo" outcome itself, the only thing
// that ever produces one. Never mutates the original checkpoint's own event.
export interface IUndoRecorder {
  recordUndo(repositoryId: string, undoneCheckpointId: string): Promise<void>;
}

// Repository Failure Policy redesign: the one new derived-state store this
// redesign adds, carved into its own narrow read interface the same way
// IRecentExecutionHistoryProvider/IUndoableExecutionHistoryProvider are
// above -- DecisionEngine only ever needs read access to failure state.
export interface IFailureStateReader {
  getFailureState(repositoryId: string, taskType: TaskType): Promise<TaskFailureState | undefined>;
  getAllFailureStates(repositoryId: string): Promise<TaskFailureState[]>;
}

// Repository Failure Policy redesign: the write side. recordTaskOutcome is
// called by ProjectMemoryService.record() itself, as a side effect of every
// recorded task outcome -- never called directly by any other caller.
// clearFailureState/clearAllFailureStates back the /clear-failures Telegram
// command (ApplicationService). Both clear* methods append a
// "failure-state-cleared" ProjectMemoryEvent (see that outcome kind's own
// doc comment) so clearing is auditable the same way every other write in
// this file already is -- never a silent reset.
export interface IFailureStateStore extends IFailureStateReader {
  recordTaskOutcome(repositoryId: string, taskType: TaskType, outcome: "success" | "failure"): Promise<TaskFailureState>;
  clearFailureState(repositoryId: string, taskType: TaskType): Promise<void>;
  clearAllFailureStates(repositoryId: string): Promise<void>;
}

export interface IProjectMemoryService
  extends IRecentExecutionHistoryProvider, IUndoableExecutionHistoryProvider, IUndoRecorder, IFailureStateStore {
  record(request: ExecutionRequest, outcome: ProjectMemoryOutcome): Promise<void>;
}
