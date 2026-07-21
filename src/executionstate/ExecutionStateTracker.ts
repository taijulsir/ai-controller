import type { IControllerCore } from "../controller/interfaces";
import type { ExecutionRequest, ExecutionResult } from "../controller/types";
import type { IExecutionStateReader } from "./interfaces";
import type { CurrentTaskSnapshot } from "./types";

// The only execution engine this codebase has today -- a plain string, not
// an enum, so a future non-Claude engine needs no type change to
// CurrentTaskSnapshot or its consumers, only a different value here.
const EXECUTOR = "Claude";

// Decorator around IControllerCore, the same shape as ApprovalEngine/
// MemoryRecordingControllerCore: wraps the inner entry point, never changes
// the request or the result, and stays transparent on every path (success,
// failure, or a thrown error) -- a tracking bug here must never affect the
// real execution outcome. Bound to controllerEntryPoint as the new outermost
// layer, so every execution reaches it exactly once per call -- including a
// workflow's own per-step re-entries, since WorkflowOrchestrator re-enters
// through this exact same seam (see DeferredControllerCore).
//
// Owns execution *metadata* only -- repositoryId, correlationId, task type,
// workflow id, current step, start time, executor, reentrancy depth. It
// never holds an AbortController, adapter, or any other long-lived resource:
// TaskPlanner alone continues to own those, and would continue to own
// cancelling them, whenever that capability is added later.
//
// Keyed by correlationId, not repositoryId: a workflow's own nested step
// re-entry always carries the exact same correlationId as its outer call
// (WorkflowOrchestrator reuses it verbatim across every step -- see its own
// doc comment), while a genuinely separate, unrelated execution -- even one
// that happens to target the same repository while the first is still
// in-flight (max_concurrent_jobs is a *global* limit, and a workflow's own
// outer "workflow"-kind call consumes no concurrency slot at all, only its
// per-step "task"-kind re-entries do, one at a time -- leaving a real,
// if narrow, window between steps) -- always gets its own distinct
// correlationId. Keying by repositoryId alone would misattribute that
// second, unrelated execution as a step of the first; keying by
// correlationId disambiguates the two correctly regardless of timing.
//
// This also means multiple independent executions can coexist in this map at
// once, including two for the same repository -- getCurrent() below picks
// one deterministically rather than assuming only one can ever exist, so
// raising max_concurrent_jobs (or otherwise allowing true per-repo
// concurrency) later needs no change to this class's internal model.
export class ExecutionStateTracker implements IControllerCore, IExecutionStateReader {
  private readonly executions = new Map<string, CurrentTaskSnapshot>();

  constructor(private readonly inner: IControllerCore) {}

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const repositoryId = request.repositoryId;
    const correlationId = request.correlationId;
    // Nothing to key by: in practice every request reaching this seam
    // already carries both (ExecutionPipeline/WorkflowOrchestrator both
    // resolve repositoryId before dispatch, and always supply a
    // correlationId) -- but tracking must never be a precondition for real
    // execution, so an untracked request still runs normally, it just never
    // appears in getCurrent().
    if (!repositoryId || !correlationId) {
      return this.inner.execute(request);
    }

    this.enter(repositoryId, correlationId, request);
    try {
      return await this.inner.execute(request);
    } finally {
      this.exit(correlationId);
    }
  }

  getCurrent(repositoryId: string): CurrentTaskSnapshot | undefined {
    // At most one entry matches in practice today (max_concurrent_jobs
    // defaults to 1, globally) -- if that default is ever raised and several
    // executions for the same repository genuinely coexist, this returns
    // whichever was registered first (Map iterates in insertion order), an
    // arbitrary but deterministic choice, not a crash or a merged/corrupted
    // record.
    for (const record of this.executions.values()) {
      if (record.repositoryId === repositoryId) {
        // Copied out, including startedAt, so a caller can never mutate
        // tracked state (even a nested Date) through the reference it's
        // handed.
        return { ...record, startedAt: new Date(record.startedAt.getTime()), progress: record.progress ? { ...record.progress } : undefined };
      }
    }
    return undefined;
  }

  private enter(repositoryId: string, correlationId: string, request: ExecutionRequest): void {
    const existing = this.executions.get(correlationId);
    if (existing) {
      // A nested re-entry (a workflow step calling back through this same
      // seam, carrying the same correlationId as its outer call) -- the
      // original task/workflow/startedAt stay exactly as the outermost call
      // recorded them; only the currently active step and the reentrancy
      // depth move.
      existing.depth += 1;
      if (request.kind === "task") {
        existing.currentStep = request.task.type;
      }
      return;
    }

    this.executions.set(correlationId, {
      repositoryId,
      correlationId,
      task: request.kind === "task" ? request.task.type : "",
      workflow: request.kind === "workflow" ? request.workflowId : "",
      currentStep: undefined,
      startedAt: new Date(),
      executor: EXECUTOR,
      progress: undefined,
      depth: 1,
    });
  }

  private exit(correlationId: string): void {
    const record = this.executions.get(correlationId);
    if (!record) {
      return;
    }
    record.depth -= 1;
    if (record.depth <= 0) {
      this.executions.delete(correlationId);
    }
  }
}
