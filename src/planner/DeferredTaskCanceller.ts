import { TaskCancellerNotBoundError } from "./errors";
import type { ITaskCanceller } from "./interfaces";

/**
 * Composition-root wiring seam, same shape as every other Deferred* class in
 * this codebase (DeferredControllerCore, DeferredExecutionStateReader, ...):
 * ApplicationService must take an ITaskCanceller at construction time, but
 * the real TaskPlanner instance is built later in src/index.ts. Not a real
 * cycle -- TaskPlanner never depends on ApplicationService -- just the same
 * construction-order constraint every other Deferred* seam already solves.
 *
 * bind() must be called synchronously, before any request that could call
 * ApplicationService.cancelCurrentTask() can possibly flow in.
 */
export class DeferredTaskCanceller implements ITaskCanceller {
  private delegate?: ITaskCanceller;

  bind(delegate: ITaskCanceller): void {
    this.delegate = delegate;
  }

  cancel(correlationId: string): boolean {
    if (!this.delegate) {
      throw new TaskCancellerNotBoundError();
    }
    return this.delegate.cancel(correlationId);
  }
}
