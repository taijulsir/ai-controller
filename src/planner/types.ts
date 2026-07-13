export type TaskType =
  | "analyze-repository"
  | "explain-code"
  | "implement-feature"
  | "fix-bug"
  | "create-commit"
  | "push-changes";

export interface AnalyzeRepositoryTask {
  type: "analyze-repository";
  input?: { focus?: string };
}

export interface ExplainCodeTask {
  type: "explain-code";
  input: { target: string };
}

export interface ImplementFeatureTask {
  type: "implement-feature";
  input: { description: string };
}

export interface FixBugTask {
  type: "fix-bug";
  input: { description: string };
}

export interface CreateCommitTask {
  type: "create-commit";
  input: { message: string };
}

export interface PushChangesTask {
  type: "push-changes";
}

export type Task =
  | AnalyzeRepositoryTask
  | ExplainCodeTask
  | ImplementFeatureTask
  | FixBugTask
  | CreateCommitTask
  | PushChangesTask;

export interface TaskExecutionContext {
  repositoryId?: string;
  correlationId?: string;
}

export interface WorkflowResult {
  success: boolean;
  output?: string;
}

export interface TaskResult extends WorkflowResult {
  taskType: TaskType;
  error?: string;
  repositoryId?: string;
  correlationId: string;
}
