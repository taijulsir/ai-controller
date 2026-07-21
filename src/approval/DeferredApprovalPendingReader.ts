import { ApprovalPendingReaderNotBoundError } from "./errors";
import type { IApprovalPendingReader } from "./interfaces";

/**
 * Composition-root wiring seam, same shape as every other Deferred* class in
 * this codebase (DeferredControllerCore, DeferredRuntimeStatusService, ...):
 * ApplicationService must take an IApprovalPendingReader at construction
 * time, but the real TelegramApprovalProvider instance is built later in
 * src/index.ts (it needs telegramClient/telegramSecurity, both constructed
 * after ApplicationService). Not a real cycle -- TelegramApprovalProvider
 * never depends on ApplicationService -- just an ordering constraint,
 * identical in spirit to DeferredRuntimeStatusService's own documented one.
 *
 * bind() must be called synchronously, before any request that could call
 * ApplicationService.getCurrentTask() can possibly flow in.
 */
export class DeferredApprovalPendingReader implements IApprovalPendingReader {
  private delegate?: IApprovalPendingReader;

  bind(delegate: IApprovalPendingReader): void {
    this.delegate = delegate;
  }

  isPending(correlationId: string): boolean {
    if (!this.delegate) {
      throw new ApprovalPendingReaderNotBoundError();
    }
    return this.delegate.isPending(correlationId);
  }
}
