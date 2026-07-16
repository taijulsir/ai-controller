import { RuntimeControlServiceNotBoundError } from "./errors";
import type { IRuntimeControlService } from "./interfaces";

/**
 * DeferredRuntimeControlService is a composition-root wiring helper,
 * mirroring DeferredRuntimeStatusService's role (Phase 8.5) for the same
 * structural reason — it contains no logic of its own beyond delegating
 * once bound.
 *
 * THE ORDERING PROBLEM IT SOLVES
 * --------------------------------
 * Phase 8.6 requires ApplicationService to take an IRuntimeControlService at
 * construction time. RuntimeControlService needs the real
 * IBackgroundRuntime instance, but IBackgroundRuntime is only built once
 * MonitoringWorker exists, which needs IProactiveMonitor, which needs
 * IApplicationService (Phase 7's own design). So IBackgroundRuntime — one of
 * RuntimeControlService's three dependencies — cannot exist until
 * ApplicationService already does, while ApplicationService now needs
 * RuntimeControlService already built. Not a dependency cycle between
 * RuntimeControlService and ApplicationService directly (RuntimeControlService
 * itself needs nothing from ApplicationService), but a real ordering
 * conflict all the same: neither can be constructed strictly before the
 * other with both requirements satisfied.
 *
 * THE TRADE-OFF THIS CLASS MAKES
 * -------------------------------
 * Identical shape to DeferredControllerCore and DeferredRuntimeStatusService:
 * the composition root constructs an unbound DeferredRuntimeControlService
 * first, hands it to ApplicationService as a stand-in
 * IRuntimeControlService, finishes building the Background Runtime cluster
 * and the real RuntimeControlService around it, and only then calls bind().
 * Every call after that point transparently reaches the real
 * RuntimeControlService.
 *
 * Every method throws RuntimeControlServiceNotBoundError if called before
 * bind() runs. The composition root (src/index.ts) must call bind()
 * synchronously, before any request that could reach
 * ApplicationService.getRuntimeControl() can possibly flow in. Wiring-only
 * seam: one instance, created and bound once in the composition root.
 */
export class DeferredRuntimeControlService implements IRuntimeControlService {
  private delegate?: IRuntimeControlService;

  bind(delegate: IRuntimeControlService): void {
    this.delegate = delegate;
  }

  pauseMonitoring(): void {
    this.resolve().pauseMonitoring();
  }

  resumeMonitoring(): void {
    this.resolve().resumeMonitoring();
  }

  enterMaintenanceMode(): void {
    this.resolve().enterMaintenanceMode();
  }

  exitMaintenanceMode(): void {
    this.resolve().exitMaintenanceMode();
  }

  enableRepository(repositoryId: string): void {
    this.resolve().enableRepository(repositoryId);
  }

  disableRepository(repositoryId: string): void {
    this.resolve().disableRepository(repositoryId);
  }

  resetDispatcherStatistics(): void {
    this.resolve().resetDispatcherStatistics();
  }

  resetRuntimeStatistics(): void {
    this.resolve().resetRuntimeStatistics();
  }

  private resolve(): IRuntimeControlService {
    if (!this.delegate) {
      throw new RuntimeControlServiceNotBoundError();
    }
    return this.delegate;
  }
}
