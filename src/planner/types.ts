import type { ArtifactMetadata } from "../artifacts";

export type TaskType =
  | "analyze-repository"
  | "explain-code"
  | "implement-feature"
  | "fix-bug"
  | "verify-git-status"
  | "create-commit"
  | "push-changes"
  | "create-pull-request"
  | "list-pull-requests"
  | "review-code"
  | "switch-branch"
  | "create-branch"
  | "fetch"
  | "sync"
  | "merge";

export interface AnalyzeRepositoryTask {
  type: "analyze-repository";
  input?: { focus?: string };
}

export interface ReviewCodeTask {
  type: "review-code";
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

export interface VerifyGitStatusTask {
  type: "verify-git-status";
}

export interface CreateCommitTask {
  type: "create-commit";
  input: { message: string };
}

export interface PushChangesTask {
  type: "push-changes";
}

export interface CreatePullRequestTask {
  type: "create-pull-request";
  input: { title: string; body?: string; baseBranch?: string };
}

export interface ListPullRequestsTask {
  type: "list-pull-requests";
}

export interface SwitchBranchTask {
  type: "switch-branch";
  input: { branch: string };
}

export interface CreateBranchTask {
  type: "create-branch";
  input: { branch: string };
}

export interface FetchTask {
  type: "fetch";
}

export interface SyncTask {
  type: "sync";
}

// Deliberately no implicit default -- CommandParser requires an explicit
// branch argument for "/merge" (a potentially significant operation is never
// inferred), so this input is required, not optional, unlike
// AnalyzeRepositoryTask/ReviewCodeTask's own optional inputs.
export interface MergeTask {
  type: "merge";
  input: { branch: string };
}

export type Task =
  | AnalyzeRepositoryTask
  | ExplainCodeTask
  | ImplementFeatureTask
  | FixBugTask
  | VerifyGitStatusTask
  | CreateCommitTask
  | PushChangesTask
  | CreatePullRequestTask
  | ListPullRequestsTask
  | ReviewCodeTask
  | SwitchBranchTask
  | CreateBranchTask
  | FetchTask
  | SyncTask
  | MergeTask;

export interface TaskExecutionContext {
  repositoryId?: string;
  correlationId?: string;
}

export interface WorkflowResult {
  success: boolean;
  output?: string;
}

// Phase B (Undo): produced only for task types ITaskCancellationPolicy's
// sibling, IUndoableTaskPolicy, marks undoable (today: implement-feature,
// fix-bug -- the only task types where Claude edits files directly).
// `id` -- not `correlationId` -- is the real undo target: WorkflowOrchestrator
// already reuses one correlationId across every step of a workflow, so a
// future workflow containing more than one Claude-editing step would produce
// several checkpoints sharing one correlationId. Every consumer (undo
// history lookup, "already undone" tracking) keys off `id`; `correlationId`
// is retained only as a grouping/display field, never as the identity.
export interface ExecutionCheckpoint {
  id: string;
  correlationId: string;
  taskType: TaskType;
  beforeSnapshot: string;
  afterSnapshot: string;
  capturedAt: Date;
}

export interface TaskResult extends WorkflowResult {
  taskType: TaskType;
  error?: string;
  repositoryId?: string;
  correlationId: string;
  checkpoint?: ExecutionCheckpoint;
  // Artifact Management: populated by ITaskArtifactRecorder for the task
  // types it covers (analyze-repository, review-code, fix-bug) on a
  // successful run -- undefined for every other task type, and also when
  // recording itself failed (never a precondition for a real task result,
  // same "degrade, never block" philosophy as checkpoint above).
  artifacts?: ArtifactMetadata[];
}
