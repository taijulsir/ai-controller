import type { ExecutionResult } from "../controller/types";

export type ProjectMemoryOutcome = { kind: "result"; result: ExecutionResult } | { kind: "error"; error: string };

export interface ProjectMemoryEvent {
  id: string;
  recordedAt: Date;
  repositoryId?: string;
  outcome: ProjectMemoryOutcome;
}
