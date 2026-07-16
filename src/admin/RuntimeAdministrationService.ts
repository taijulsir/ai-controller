import type { IRuntimeControlService } from "../control/interfaces";
import type { IRuntimePolicyEngine } from "../policy/interfaces";
import type { RuntimePolicyStatus } from "../policy/types";
import type { IRuntimeStatusService } from "../status/interfaces";
import type { RuntimeStatus } from "../status/types";
import type { IRuntimeAdministrationService } from "./interfaces";

// Application-level administrative facade — NOT another runtime component.
// Owns zero mutable state: no fields beyond its three readonly constructor
// references, and performs composition only. Every method is exactly one
// direct delegating call, returning the original object its collaborator
// already produced — never reconstructed, re-derived, or wrapped.
//
// Depends only on the three PUBLIC interfaces the runtime layer already
// exposes (IRuntimeStatusService, IRuntimeControlService,
// IRuntimePolicyEngine). It has no dependency on MonitoringWorker,
// BackgroundRuntime, AttentionDispatcher, Telegram, ExecutionPipeline, or any
// repository service — it cannot reach any of them, by construction, because
// nothing here holds a reference to them.
//
// getPolicies() calls IRuntimePolicyEngine.getStatus() directly rather than
// reading RuntimeStatus.policy (RuntimeStatusService already embeds an
// equivalent RuntimePolicyStatus there) — this keeps getPolicies() correct
// independent of however RuntimeStatusService happens to compose its own
// snapshot, rather than coupling one facade's correctness to another
// facade's internal choices.
export class RuntimeAdministrationService implements IRuntimeAdministrationService {
  constructor(
    private readonly runtimeStatusService: IRuntimeStatusService,
    private readonly runtimeControlService: IRuntimeControlService,
    private readonly runtimePolicyEngine: IRuntimePolicyEngine,
  ) {}

  getStatus(): RuntimeStatus {
    return this.runtimeStatusService.getStatus();
  }

  getControl(): IRuntimeControlService {
    return this.runtimeControlService;
  }

  getPolicies(): RuntimePolicyStatus {
    return this.runtimePolicyEngine.getStatus();
  }
}
