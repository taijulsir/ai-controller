import { RuntimeStatusServiceNotBoundError } from "./errors";
import type { IRuntimeStatusService } from "./interfaces";
import type { RuntimeStatus } from "./types";

/**
 * DeferredRuntimeStatusService is a composition-root wiring helper, exactly
 * mirroring DeferredControllerCore's role for a structurally identical
 * problem — it contains no logic of its own beyond delegating once bound.
 *
 * THE CYCLE IT BREAKS
 * --------------------
 * Phase 8.5 requires ApplicationService to take an IRuntimeStatusService at
 * construction time. But:
 *   1. RuntimeStatusService needs the concrete MonitoringWorker instance
 *      (to report its own tick/activity status).
 *   2. MonitoringWorker needs a IProactiveMonitor.
 *   3. ProactiveMonitor needs IApplicationService (Phase 7's own design —
 *      it calls ApplicationService.getRecommendations() rather than
 *      recomputing recommendations itself).
 *
 * Combine these and ApplicationService would need RuntimeStatusService to
 * already exist before it can be constructed, while RuntimeStatusService
 * (transitively, via MonitoringWorker -> ProactiveMonitor) needs
 * ApplicationService to already exist first. Neither can be `new`-ed first
 * without the other already existing — a real construction-time cycle, not
 * a hypothetical one.
 *
 * THE TRADE-OFF THIS CLASS MAKES
 * -------------------------------
 * Same shape as DeferredControllerCore: the composition root constructs an
 * unbound DeferredRuntimeStatusService first, hands it to ApplicationService
 * as a stand-in IRuntimeStatusService, finishes building ProactiveMonitor /
 * MonitoringWorker / the rest of the Background Runtime cluster / the real
 * RuntimeStatusService around it, and only then calls bind() with the real
 * instance. Every getRuntimeStatus() call after that point transparently
 * reaches the real RuntimeStatusService.
 *
 * getStatus() throws RuntimeStatusServiceNotBoundError if ever called before
 * bind() runs. The composition root (src/index.ts) must call bind()
 * synchronously, before any request that could call
 * ApplicationService.getRuntimeStatus() can possibly flow in — identical
 * guarantee to DeferredControllerCore's own. This is a wiring-only seam: one
 * instance, created and bound once in the composition root, not a
 * general-purpose pattern to reach for elsewhere.
 */
export class DeferredRuntimeStatusService implements IRuntimeStatusService {
  private delegate?: IRuntimeStatusService;

  bind(delegate: IRuntimeStatusService): void {
    this.delegate = delegate;
  }

  getStatus(): RuntimeStatus {
    if (!this.delegate) {
      throw new RuntimeStatusServiceNotBoundError();
    }
    return this.delegate.getStatus();
  }
}
