import type { Task, TaskExecutionContext, TaskResult, TaskType, WorkflowResult } from "./types";

export interface ITaskWorkflow {
  execute(task: Task, signal: AbortSignal): Promise<WorkflowResult>;
}

export interface IWorkflowFactory {
  create(task: Task, context: TaskExecutionContext): ITaskWorkflow;
}

// Narrow view of ITaskPlanner's own cancel() capability, carved out the same
// way IAutonomousPlanScheduleProvider/IRecentExecutionHistoryProvider narrow
// IApplicationService's own dependents -- ApplicationService's only
// legitimate need here is "abort the run registered under this
// correlationId," never run() itself (which would let it start new task
// execution, a capability well outside what /task cancel's composition
// requires). TaskPlanner requires no change to satisfy this beyond
// implementing cancel() once: ITaskPlanner extends this interface rather
// than redeclaring the method, so there is exactly one declaration of it.
export interface ITaskCanceller {
  // Returns false when nothing is registered for this correlationId (already
  // finished) or when it was already aborted (a second cancel request while
  // the first is still unwinding) -- true only the one time it actually
  // triggers a fresh abort.
  cancel(correlationId: string): boolean;
}

export interface ITaskPlanner extends ITaskCanceller {
  run(task: Task, context?: TaskExecutionContext): Promise<TaskResult>;
}

// Pure decision table over TaskType -- zero dependencies, zero I/O, exactly
// the same shape as ApprovalPolicy (src/approval/ApprovalPolicy.ts): a
// mechanism (TaskPlanner.cancel(), ApprovalEngine.execute()) stays purely
// mechanical, while a separate policy object owns the judgment of when that
// mechanism should actually be invoked. Consulted by ApplicationService
// before it ever calls ITaskCanceller.cancel() -- TaskPlanner itself has no
// opinion on which task types are worth aborting, it only knows how to abort
// whatever is registered. Adding a newly-cancellable task type later is a
// one-line change here, never a change to /task cancel's own flow.
export interface ITaskCancellationPolicy {
  canCancel(taskType: TaskType): boolean;
}

// Same pure-policy shape as ITaskCancellationPolicy above (and ApprovalPolicy
// before it) -- zero dependencies, zero I/O. A separate concept from
// cancellability on purpose: today's undoable set (implement-feature,
// fix-bug -- task types where Claude edits files directly) happens to be a
// subset of the cancellable set, but the two questions are not the same one
// (a future task type could be worth interrupting without being meaningfully
// undoable, or vice versa), so they get their own policy rather than being
// conflated. Consulted by TaskPlanner before it ever calls
// IUndoCheckpointRecorder.capture() -- adding a newly-undoable task type
// later is a one-line change here, never a change to TaskPlanner's own
// control flow or to /undo itself.
export interface IUndoableTaskPolicy {
  isUndoable(taskType: TaskType): boolean;
}

// Purely mechanical, mirroring ITaskCanceller's own split from
// ITaskCancellationPolicy: this has no opinion on which task types are worth
// snapshotting, it only knows how to take one snapshot of a repository's
// current working tree right now. TaskPlanner calls this twice per undoable
// task attempt (before and after workflow.execute()) and assembles the
// resulting pair into an ExecutionCheckpoint itself.
export interface IUndoCheckpointRecorder {
  capture(repositoryId: string): Promise<string>;
}
