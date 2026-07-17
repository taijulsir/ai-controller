import type { ExecutionRequest } from "../controller/types";
import type { ProjectMemoryEvent, ProjectMemoryOutcome } from "./types";

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

export interface IProjectMemoryService extends IRecentExecutionHistoryProvider {
  record(request: ExecutionRequest, outcome: ProjectMemoryOutcome): Promise<void>;
}
