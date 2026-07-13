import type { Task, TaskResult } from "../planner/types";

export interface ExecutionRequest {
  task: Task;
  repositoryId?: string;
  correlationId?: string;
}

export interface ExecutionResult {
  taskResult: TaskResult;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
  warnings?: string[];
  telemetry?: Record<string, unknown>;
  approval?: {
    required: boolean;
    approvedBy?: string;
    approvedAt?: Date;
  };
}
