import type { Severity } from "../domain/severity/Severity";
import type { WorkerStatus } from "../runtime/types";
import type { RuntimeStatus } from "../status/types";
import type { IRuntimeDiagnosticsEngine } from "./interfaces";
import type { DiagnosticFinding, DiagnosticFindingKind, RuntimeDiagnosticsReport, RuntimeHealthLevel } from "./types";

const MONITORING_WORKER_ID = "monitoring-worker";

// Kept internal for now, same "kept internal for now" precedent as
// DecisionEngine's thresholds and RuntimePolicyEngine's defaults.
// MonitoringWorker's actual configured tick interval (15 minutes by default)
// is deliberately not exposed anywhere in RuntimeStatus (see this class's own
// architectural note below), so this is a conservative, independent
// threshold — several multiples of the default interval — not a reflection
// of whatever interval happens to be configured.
const MONITORING_STALE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

// Findings that, on their own, indicate something is degraded rather than
// merely explaining expected/intentional behavior. MaintenanceModeActive,
// QuietHoursActive, and RepositoryCooldownActive are deliberately excluded —
// they explain current behavior without themselves being a problem.
const DEGRADED_FINDING_KINDS: ReadonlySet<DiagnosticFindingKind> = new Set([
  "WorkerUnavailable",
  "MonitoringStale",
  "NotificationBudgetExhausted",
  "RepositoryMonitoringDisabled",
]);

/**
 * Pure, dependency-free transform — no constructor dependencies, no I/O,
 * fully synchronous. It only ever reads the RuntimeStatus object it's
 * handed: it never calls IRuntimeStatusService, IRuntimeAdministrationService,
 * IRuntimePolicyEngine, IRuntimeControlService, Telegram, any repository
 * service, ControllerCore, or Claude — there is no dependency here capable of
 * any of that, by construction, because this class holds no reference to any
 * of them. Every finding and the overall health verdict are derived entirely
 * from fields RuntimeStatusService/RuntimePolicyEngine/AttentionDispatcher/
 * BackgroundRuntime already computed (Phases 8.4-8.7); nothing here
 * recomputes quiet-hours math, cooldown math, or budget math itself — it
 * only reads the booleans/counts those modules already produced.
 *
 * ARCHITECTURAL NOTE — discovered during Phase 8.8 implementation:
 * The reviewed rollup rules named four UNHEALTHY triggers: runtime stopped,
 * monitoring unavailable, multiple worker failures, and dispatcher
 * unavailable. The first three are fully detectable from RuntimeStatus as it
 * exists today (RuntimeStopped; the "monitoring-worker" entry in
 * RuntimeStatus.workers; counting entries with running: false). The fourth —
 * "dispatcher unavailable" — is NOT detectable: AttentionDispatcherStatus
 * (Phase 8.5) has no field representing whether the dispatcher itself is
 * available, because AttentionDispatcher has no start()/stop() lifecycle at
 * all (unlike BackgroundRuntime/MonitoringWorker, which are IBackgroundWorkers
 * with explicit running/not-running state) — it is always constructible and
 * always callable. There is nothing in the current data model for this
 * engine to observe here. Rather than fabricate a heuristic (e.g. inferring
 * "unavailable" from zero recent notifications, which is equally consistent
 * with "everything is healthy and there was nothing to report") or extend
 * AttentionDispatcher/AttentionDispatcherStatus with new state outside this
 * phase's reviewed file scope, this is left undetected and undocumented as a
 * DiagnosticFindingKind — a real, acknowledged gap for a future phase to
 * close if dispatcher health ever needs its own explicit signal, not a
 * silently-broken promise.
 */
export class RuntimeDiagnosticsEngine implements IRuntimeDiagnosticsEngine {
  diagnose(status: RuntimeStatus): RuntimeDiagnosticsReport {
    const findings: DiagnosticFinding[] = [
      ...this.detectRuntimeStopped(status),
      ...this.detectWorkerUnavailable(status),
      ...this.detectMonitoringStale(status),
      ...this.detectMaintenanceMode(status),
      ...this.detectQuietHours(status),
      ...this.detectNotificationBudgetExhausted(status),
      ...this.detectRepositoryMonitoringDisabled(status),
      ...this.detectRepositoryCooldownActive(status),
    ];

    const health = this.rollUpHealth(status, findings);

    return {
      health,
      summary: this.buildSummary(health, findings),
      findings,
      generatedAt: new Date(),
    };
  }

  private detectRuntimeStopped(status: RuntimeStatus): DiagnosticFinding[] {
    if (status.runtime.running) {
      return [];
    }
    return [
      {
        kind: "RuntimeStopped",
        severity: "critical",
        message: "The background runtime is not running — no monitoring or notification delivery can occur.",
      },
    ];
  }

  // Only evaluated while the runtime itself is running: a worker reporting
  // not-running purely as a consequence of the whole runtime being stopped
  // is not an independent problem — detectRuntimeStopped() already covers
  // that case, and duplicating it here would just be noise.
  private detectWorkerUnavailable(status: RuntimeStatus): DiagnosticFinding[] {
    if (!status.runtime.running) {
      return [];
    }
    const unavailable = this.getUnavailableWorkers(status);
    return unavailable.map((worker) => this.buildWorkerUnavailableFinding(worker, unavailable.length));
  }

  private buildWorkerUnavailableFinding(worker: WorkerStatus, unavailableCount: number): DiagnosticFinding {
    const isMonitoringWorker = worker.id === MONITORING_WORKER_ID;
    const severity: Severity = isMonitoringWorker || unavailableCount >= 2 ? "critical" : "warning";
    return {
      kind: "WorkerUnavailable",
      severity,
      message: `Worker "${worker.id}" is not running.`,
    };
  }

  private detectMonitoringStale(status: RuntimeStatus): DiagnosticFinding[] {
    if (!status.runtime.running) {
      return [];
    }
    const { lastCycleAt } = status.monitoring;
    const nowMs = Date.now();
    const isStale = lastCycleAt
      ? nowMs - lastCycleAt.getTime() > MONITORING_STALE_THRESHOLD_MS
      : (status.runtime.uptimeMs ?? 0) > MONITORING_STALE_THRESHOLD_MS;

    if (!isStale) {
      return [];
    }
    return [
      {
        kind: "MonitoringStale",
        severity: "warning",
        message: lastCycleAt
          ? `No monitoring cycle has completed since ${lastCycleAt.toISOString()}, despite the runtime being active.`
          : "The runtime has been active for a while but no monitoring cycle has completed yet.",
      },
    ];
  }

  // Intentional operator state: explains current behavior, never itself a
  // problem — excluded from DEGRADED_FINDING_KINDS.
  private detectMaintenanceMode(status: RuntimeStatus): DiagnosticFinding[] {
    if (!status.policy.maintenanceMode) {
      return [];
    }
    return [
      {
        kind: "MaintenanceModeActive",
        severity: "info",
        message: "Maintenance mode is active — monitoring and notifications are intentionally suppressed.",
      },
    ];
  }

  // Intentional, time-based state: explains current behavior, never itself a
  // problem — excluded from DEGRADED_FINDING_KINDS.
  private detectQuietHours(status: RuntimeStatus): DiagnosticFinding[] {
    if (!status.policy.quietHoursActive) {
      return [];
    }
    return [
      {
        kind: "QuietHoursActive",
        severity: "info",
        message: "Quiet hours are currently active — notifications are intentionally suppressed.",
      },
    ];
  }

  private detectNotificationBudgetExhausted(status: RuntimeStatus): DiagnosticFinding[] {
    const { used, max } = status.policy.globalNotificationBudget;
    if (used < max) {
      return [];
    }
    return [
      {
        kind: "NotificationBudgetExhausted",
        severity: "warning",
        message: `The global notification budget is exhausted (${used}/${max} within the current window) — further notifications are being suppressed.`,
      },
    ];
  }

  private detectRepositoryMonitoringDisabled(status: RuntimeStatus): DiagnosticFinding[] {
    if (status.policy.repositoriesDisabled <= 0) {
      return [];
    }
    return [
      {
        kind: "RepositoryMonitoringDisabled",
        severity: "warning",
        message: `${status.policy.repositoriesDisabled} repositor${status.policy.repositoriesDisabled === 1 ? "y has" : "ies have"} monitoring disabled.`,
      },
    ];
  }

  // Cooldown is a normal, expected, self-resolving consequence of recent
  // delivery activity, not evidence of a problem — excluded from
  // DEGRADED_FINDING_KINDS, same treatment as maintenance mode/quiet hours.
  private detectRepositoryCooldownActive(status: RuntimeStatus): DiagnosticFinding[] {
    if (status.policy.repositoriesInCooldown <= 0) {
      return [];
    }
    return [
      {
        kind: "RepositoryCooldownActive",
        severity: "info",
        message: `${status.policy.repositoriesInCooldown} repositor${status.policy.repositoriesInCooldown === 1 ? "y is" : "ies are"} within their notification cooldown.`,
      },
    ];
  }

  private getUnavailableWorkers(status: RuntimeStatus): WorkerStatus[] {
    return status.workers.filter((worker) => !worker.running);
  }

  // Ceiling wins: unhealthy conditions are checked first, then degraded,
  // otherwise healthy. Intentional-state findings (MaintenanceModeActive,
  // QuietHoursActive, RepositoryCooldownActive) never appear in
  // DEGRADED_FINDING_KINDS, so they can never reduce health by themselves —
  // regardless of how many of them are present or in what combination.
  private rollUpHealth(status: RuntimeStatus, findings: DiagnosticFinding[]): RuntimeHealthLevel {
    if (!status.runtime.running) {
      return "unhealthy";
    }

    const unavailableWorkers = this.getUnavailableWorkers(status);
    const monitoringWorkerDown = unavailableWorkers.some((worker) => worker.id === MONITORING_WORKER_ID);
    if (monitoringWorkerDown) {
      return "unhealthy";
    }
    if (unavailableWorkers.length >= 2) {
      return "unhealthy";
    }

    const hasDegradedFinding = findings.some((finding) => DEGRADED_FINDING_KINDS.has(finding.kind));
    return hasDegradedFinding ? "degraded" : "healthy";
  }

  private buildSummary(health: RuntimeHealthLevel, findings: DiagnosticFinding[]): string {
    if (health === "unhealthy") {
      return "Runtime unavailable.";
    }
    if (health === "healthy") {
      return "Runtime healthy.";
    }

    const topics: string[] = [];
    if (findings.some((finding) => finding.kind === "MonitoringStale")) {
      topics.push("monitoring");
    }
    if (findings.some((finding) => finding.kind === "NotificationBudgetExhausted")) {
      topics.push("notifications");
    }
    if (findings.some((finding) => finding.kind === "RepositoryMonitoringDisabled")) {
      topics.push("repository coverage");
    }
    if (findings.some((finding) => finding.kind === "WorkerUnavailable")) {
      topics.push("workers");
    }

    return `Runtime operational with degraded ${topics.join(", ")}.`;
  }
}
