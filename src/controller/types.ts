import type { Task, TaskResult, TaskType } from "../planner/types";

export type ExecutionRequest =
  | { kind: "task"; task: Task; repositoryId?: string; correlationId?: string }
  | { kind: "workflow"; workflowId: string; input?: Record<string, unknown>; repositoryId?: string; correlationId?: string };

export interface WorkflowExecutionRequest {
  workflowId: string;
  repositoryId: string;
  input: Record<string, unknown>;
  correlationId: string;
}

export interface StepExecutionResult {
  stepId: string;
  taskType: TaskType;
  executionResult: ExecutionResult;
}

export interface OrchestrationResult {
  workflowId: string;
  correlationId: string;
  status: "completed" | "failed";
  steps: StepExecutionResult[];
  failedStep?: StepExecutionResult;
  startedAt: Date;
  completedAt: Date;
  durationMs: number;
}

export type ExecutionResult =
  | {
      kind: "task";
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
  | {
      kind: "workflow";
      workflowResult: OrchestrationResult;
      startedAt: Date;
      completedAt: Date;
      durationMs: number;
    };

export function isTaskExecutionResult(result: ExecutionResult): result is Extract<ExecutionResult, { kind: "task" }> {
  return result.kind === "task";
}
