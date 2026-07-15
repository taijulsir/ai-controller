import type { RepositorySnapshot } from "../intelligence/types";
import type { ProjectMemoryEvent } from "../memory/types";
import type { Task } from "../planner/types";

export interface ExecutionContextRequest {
  repository: RepositorySnapshot;
  task?: Task;
  activeWorkflow?: { workflowId: string; stepId?: string };
  historyLimit?: number;
}

export interface ExecutionContext {
  repository: RepositorySnapshot;
  recentHistory: ProjectMemoryEvent[];
  relevantHistory: ProjectMemoryEvent[];
  activeWorkflow?: { workflowId: string; stepId?: string };
  task?: Task;
  generatedAt: Date;
  warnings: string[];
}
