import { ApprovalCancellerNotBoundError } from "./errors";
import type { IApprovalCanceller } from "./interfaces";

/**
 * Composition-root wiring seam, same shape as DeferredApprovalPendingReader
 * (and every other Deferred* class in this codebase): ApplicationService
 * must take an IApprovalCanceller at construction time, but the real
 * TelegramApprovalProvider instance is built later in src/index.ts. Kept as
 * its own class, bound to the same underlying TelegramApprovalProvider
 * instance as DeferredApprovalPendingReader, rather than folded into that
 * one seam -- each Deferred* wrapper stays as narrow as the interface it
 * stands in for, so a consumer holding only a DeferredApprovalPendingReader
 * reference is never type-level capable of rejecting anything.
 *
 * bind() must be called synchronously, before any request that could call
 * ApplicationService.cancelCurrentTask() can possibly flow in.
 */
export class DeferredApprovalCanceller implements IApprovalCanceller {
  private delegate?: IApprovalCanceller;

  bind(delegate: IApprovalCanceller): void {
    this.delegate = delegate;
  }

  reject(correlationId: string, reason?: string): boolean {
    if (!this.delegate) {
      throw new ApprovalCancellerNotBoundError();
    }
    return this.delegate.reject(correlationId, reason);
  }
}
