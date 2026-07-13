import type { Task, TaskExecutionContext, TaskResult, WorkflowResult } from "./types";

export interface ITaskWorkflow {
  execute(task: Task, signal: AbortSignal): Promise<WorkflowResult>;
}

export interface IWorkflowFactory {
  create(task: Task, context: TaskExecutionContext): ITaskWorkflow;
}

export interface ITaskPlanner {
  run(task: Task, context?: TaskExecutionContext): Promise<TaskResult>;
}
