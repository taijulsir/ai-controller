import type { IAttentionDispatcher } from "../attention/interfaces";
import type { IRuntimePolicyEngine } from "../policy/interfaces";
import type { MonitoringWorker } from "../runtime/MonitoringWorker";
import type { IBackgroundRuntime } from "../runtime/interfaces";
import type { IRuntimeStatusService } from "./interfaces";
import type { RuntimeStatus } from "./types";

// Pure read-only composition, zero internal state of its own: every field in
// the snapshot it returns is copied directly from one of its four
// collaborators' own getStatus() — never recomputed, re-derived, or
// second-guessed — plus a generatedAt timestamp marking assembly time, the
// same convention every other "report" type in this codebase already follows
// (RepositorySnapshot, RepositoryInsightReport, EngineeringWorkspace, ...).
//
// It never calls start(), stop(), evaluate(), dispatch(), setMaintenanceMode(),
// setRepositoryMonitoringEnabled(), or recordNotificationSent() on any
// collaborator — only their getStatus() query methods — so it has no way to
// trigger monitoring, delivery, or change policy state, by construction.
//
// Depends on the concrete MonitoringWorker class (not a new single-purpose
// interface) for its one getStatus() method: introducing an interface whose
// only reason to exist would be exposing that one getter was judged not
// worth it, so IBackgroundWorker stays completely generic and unchanged.
export class RuntimeStatusService implements IRuntimeStatusService {
  constructor(
    private readonly backgroundRuntime: IBackgroundRuntime,
    private readonly monitoringWorker: MonitoringWorker,
    private readonly attentionDispatcher: IAttentionDispatcher,
    private readonly runtimePolicy: IRuntimePolicyEngine,
  ) {}

  getStatus(): RuntimeStatus {
    const runtimeStatus = this.backgroundRuntime.getStatus();

    return {
      runtime: {
        running: runtimeStatus.running,
        startedAt: runtimeStatus.startedAt,
        uptimeMs: runtimeStatus.uptimeMs,
      },
      workers: runtimeStatus.workers,
      monitoring: this.monitoringWorker.getStatus(),
      policy: this.runtimePolicy.getStatus(),
      attention: this.attentionDispatcher.getStatus(),
      generatedAt: new Date(),
    };
  }
}
