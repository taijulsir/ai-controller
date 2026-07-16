import { RuntimeAdministrationServiceNotBoundError } from "./errors";
import type { IRuntimeAdministrationService } from "./interfaces";
import type { IRuntimeControlService } from "../control/interfaces";
import type { RuntimePolicyStatus } from "../policy/types";
import type { RuntimeStatus } from "../status/types";

/**
 * DeferredRuntimeAdministrationService is a composition-root wiring helper,
 * mirroring DeferredRuntimeStatusService (Phase 8.5) and
 * DeferredRuntimeControlService (Phase 8.6) for the same structural reason —
 * it contains no logic of its own beyond delegating once bound.
 *
 * THE ORDERING PROBLEM IT SOLVES
 * --------------------------------
 * Phase 8.7 requires ApplicationService to take an IRuntimeAdministrationService
 * at construction time. RuntimeAdministrationService needs the real
 * IRuntimeStatusService, IRuntimeControlService, and IRuntimePolicyEngine —
 * all three of which are only built as part of the Background Runtime
 * cluster, after ApplicationService already exists (that cluster's
 * ProactiveMonitor needs this exact applicationService instance first). So
 * none of RuntimeAdministrationService's three dependencies can exist until
 * ApplicationService already does, while ApplicationService now needs
 * RuntimeAdministrationService already built. Same ordering conflict as the
 * two seams before it, not a new kind of problem.
 *
 * THE TRADE-OFF THIS CLASS MAKES
 * -------------------------------
 * Identical shape to the other two deferred seams: the composition root
 * constructs an unbound DeferredRuntimeAdministrationService first, hands it
 * to ApplicationService as a stand-in IRuntimeAdministrationService, finishes
 * building the Background Runtime cluster and the real
 * RuntimeStatusService/RuntimeControlService/RuntimePolicyEngine around it,
 * then constructs the real RuntimeAdministrationService and binds it. Every
 * call after that point transparently reaches the real
 * RuntimeAdministrationService.
 *
 * Every method throws RuntimeAdministrationServiceNotBoundError if called
 * before bind() runs. The composition root (src/index.ts) must call bind()
 * synchronously, before any request that could reach
 * ApplicationService.getRuntimeAdministration() can possibly flow in.
 * Wiring-only seam: one instance, created and bound once in the composition
 * root.
 */
export class DeferredRuntimeAdministrationService implements IRuntimeAdministrationService {
  private delegate?: IRuntimeAdministrationService;

  bind(delegate: IRuntimeAdministrationService): void {
    this.delegate = delegate;
  }

  getStatus(): RuntimeStatus {
    return this.resolve().getStatus();
  }

  getControl(): IRuntimeControlService {
    return this.resolve().getControl();
  }

  getPolicies(): RuntimePolicyStatus {
    return this.resolve().getPolicies();
  }

  private resolve(): IRuntimeAdministrationService {
    if (!this.delegate) {
      throw new RuntimeAdministrationServiceNotBoundError();
    }
    return this.delegate;
  }
}
