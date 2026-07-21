import { ExecutionStateReaderNotBoundError } from "./errors";
import type { IExecutionStateReader } from "./interfaces";
import type { CurrentTaskSnapshot } from "./types";

/**
 * Composition-root wiring seam, mirroring DeferredRuntimeStatusService's own
 * role for a structurally identical ordering problem: ApplicationService
 * must take an IExecutionStateReader at construction time, but the real
 * ExecutionStateTracker cannot be built until the fully-decorated
 * ControllerCore stack it wraps (ApprovalEngine, MemoryRecordingControllerCore)
 * already exists -- which happens well after ApplicationService is
 * constructed in src/index.ts. This is not a real dependency cycle (nothing
 * ExecutionStateTracker depends on ever reaches back to ApplicationService),
 * just an ordering constraint -- the same shape DeferredRuntimeStatusService
 * already documents in detail.
 *
 * bind() must be called synchronously, before any request that could call
 * ApplicationService.getCurrentTask() can possibly flow in -- identical
 * guarantee to every other Deferred* seam in this codebase.
 */
export class DeferredExecutionStateReader implements IExecutionStateReader {
  private delegate?: IExecutionStateReader;

  bind(delegate: IExecutionStateReader): void {
    this.delegate = delegate;
  }

  getCurrent(repositoryId: string): CurrentTaskSnapshot | undefined {
    if (!this.delegate) {
      throw new ExecutionStateReaderNotBoundError();
    }
    return this.delegate.getCurrent(repositoryId);
  }
}
