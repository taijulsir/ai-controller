// Plain execution metadata only -- no adapter, session, or AbortController
// reference lives here. ExecutionStateTracker (the sole producer of this
// shape) never takes ownership of a resource, only describes one that
// TaskPlanner/WorkflowOrchestrator continue to own for their own lifetimes.
export interface CurrentTaskSnapshot {
  repositoryId: string;
  correlationId: string;

  // Task type of a standalone task-kind execution (e.g. "implement-feature").
  // Empty string when this execution is a workflow instead -- see `workflow`.
  task: string;
  // Workflow id of a workflow-kind execution (e.g. "ship"). Empty string when
  // this execution is a standalone task instead -- see `task`.
  workflow: string;
  // Task type of whichever step is presently executing. Set only once a
  // workflow's step re-enters the same ControllerCore seam (see
  // ExecutionStateTracker) -- undefined for a standalone task (which never
  // re-enters) and for a workflow before its first step has started.
  currentStep?: string;

  startedAt: Date;

  // Which execution engine ran this -- a plain string today ("Claude"), not
  // an enum, so a future non-Claude engine needs no type change here, only a
  // different value.
  executor: string;

  // Reserved, not populated yet: no existing producer knows total step count
  // without new plumbing through WorkflowOrchestrator/WorkflowRegistry.
  // Keeping the field now avoids a later shape change to this type or its
  // consumers once that plumbing exists.
  progress?: {
    completed: number;
    total: number;
  };

  // Reentrancy depth for this repository's tracked execution: 1 for the
  // outermost call, incremented for each nested re-entry (a workflow step
  // calling back through the same ControllerCore seam), decremented on
  // return. The record is removed once depth reaches 0, not when any single
  // call returns -- see ExecutionStateTracker.
  depth: number;
}

// ExecutionStateTracker only ever knows "an execution exists" -- it has no
// concept of approval. This status is computed, not stored: ApplicationService
// derives it by cross-checking IApprovalPendingReader against the snapshot's
// own correlationId, never by adding a field ExecutionStateTracker would have
// to set itself.
export type CurrentTaskStatus = "running" | "waiting-approval";

// The composed view ApplicationService produces for /task: CurrentTaskSnapshot
// (owned by ExecutionStateTracker) plus status (derived from
// IApprovalPendingReader) plus a display-friendly repository name (read from
// IRepositoryRegistry, a cheap in-memory lookup) -- none of which
// ExecutionStateTracker computes or stores itself.
export interface CurrentTaskReport {
  status: CurrentTaskStatus;
  repositoryName: string;
  snapshot: CurrentTaskSnapshot;
}

// The composed view ApplicationService.cancelCurrentTask() produces --
// spans three independently-owned facts (ExecutionStateTracker: does an
// execution exist; IApprovalPendingReader: is it waiting on approval;
// ITaskCancellationPolicy: is its current task type actually cancellable),
// none of which are re-derived or duplicated here, only composed and
// reported. `snapshot` is omitted only for the two outcomes that have none
// to report ("nothing-running": no execution was found at all;
// "already-finished": one existed a moment ago but resolved on its own
// before the cancel request reached it -- indistinguishable from "nothing
// running" by the time this runs, since no stale record is ever kept around
// to tell the two apart).
export type TaskCancellationOutcome =
  | { kind: "nothing-running" }
  | { kind: "already-finished" }
  | { kind: "cancelled"; snapshot: CurrentTaskSnapshot }
  | { kind: "cancelled-approval"; snapshot: CurrentTaskSnapshot }
  | { kind: "not-cancellable"; snapshot: CurrentTaskSnapshot }
  | { kind: "already-cancelling"; snapshot: CurrentTaskSnapshot };
