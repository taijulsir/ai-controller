import type { ExecutionRequest } from "../controller/types";
import type { ProjectMemoryEvent, ProjectMemoryOutcome } from "./types";

export interface IProjectMemoryService {
  record(request: ExecutionRequest, outcome: ProjectMemoryOutcome): Promise<void>;
  getRecentEvents(options?: { repositoryId?: string; limit?: number }): Promise<ProjectMemoryEvent[]>;
}
