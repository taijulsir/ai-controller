import { RuntimeDiagnosticsEngine } from "../src/diagnostics/RuntimeDiagnosticsEngine";
import type { WorkerStatus } from "../src/runtime/types";
import type { RuntimeStatus } from "../src/status/types";

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

// A fully healthy baseline — every override in the tests below starts from
// this and changes only what that scenario needs, so each test's intent is
// obvious from its diff against this baseline.
function healthyStatus(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    runtime: { running: true, startedAt: new Date(Date.now() - 5 * 60 * 1000), uptimeMs: 5 * 60 * 1000 },
    workers: [{ id: "monitoring-worker", running: true }],
    monitoring: { running: true, lastCycleAt: new Date(), repositoriesMonitoredLastCycle: 2, repositoriesSkippedLastCycle: 0 },
    policy: {
      maintenanceMode: false,
      quietHoursActive: false,
      repositoriesDisabled: 0,
      repositoriesInCooldown: 0,
      globalNotificationBudget: { used: 0, max: 5, windowMs: 60 * 60 * 1000 },
    },
    attention: { lastDispatchAt: undefined, notificationsDelivered: 0, notificationsSuppressed: 0 },
    generatedAt: new Date(),
    ...overrides,
  };
}

function findKind(report: ReturnType<RuntimeDiagnosticsEngine["diagnose"]>, kind: string) {
  return report.findings.find((finding) => finding.kind === kind);
}

async function main(): Promise<void> {
  const engine = new RuntimeDiagnosticsEngine();

  // Healthy baseline: no findings at all, health "healthy", exact summary text.
  {
    const report = engine.diagnose(healthyStatus());
    assert(report.health === "healthy", "healthy baseline -> health: healthy");
    assert(report.findings.length === 0, "healthy baseline -> zero findings");
    assert(report.summary === "Runtime healthy.", `healthy baseline -> summary is exactly "Runtime healthy." (got "${report.summary}")`);
    assert(report.generatedAt instanceof Date, "report carries a generatedAt timestamp");
  }

  // Runtime stopped -> unhealthy, critical RuntimeStopped finding, no
  // worker/monitoring findings piled on top (they're consequences, not
  // independent problems).
  {
    const status = healthyStatus({
      runtime: { running: false, startedAt: undefined, uptimeMs: undefined },
      workers: [{ id: "monitoring-worker", running: false }],
    });
    const report = engine.diagnose(status);
    assert(report.health === "unhealthy", "runtime stopped -> health: unhealthy");
    assert(report.summary === "Runtime unavailable.", `runtime stopped -> summary is exactly "Runtime unavailable." (got "${report.summary}")`);
    const stopped = findKind(report, "RuntimeStopped");
    assert(stopped?.severity === "critical", "runtime stopped -> a critical RuntimeStopped finding is present");
    assert(!findKind(report, "WorkerUnavailable"), "runtime stopped -> no separate WorkerUnavailable finding (it's a consequence, not an independent problem)");
    assert(!findKind(report, "MonitoringStale"), "runtime stopped -> no separate MonitoringStale finding either");
  }

  // Worker unavailable (the monitoring worker itself, runtime otherwise
  // running) -> unhealthy ("monitoring unavailable"), critical severity.
  {
    const status = healthyStatus({ workers: [{ id: "monitoring-worker", running: false }] });
    const report = engine.diagnose(status);
    assert(report.health === "unhealthy", "the monitoring worker being down while the runtime is running -> health: unhealthy");
    const finding = findKind(report, "WorkerUnavailable");
    assert(finding?.severity === "critical", "the monitoring worker being down produces a critical WorkerUnavailable finding");
  }

  // Worker unavailable (a different, non-monitoring worker, runtime
  // otherwise running) -> degraded, warning severity — a single generic
  // worker failure is not as severe as losing the monitoring worker itself.
  {
    const status = healthyStatus({
      workers: [
        { id: "monitoring-worker", running: true },
        { id: "future-worker", running: false },
      ],
    });
    const report = engine.diagnose(status);
    assert(report.health === "degraded", "a single non-monitoring worker being down -> health: degraded");
    const finding = findKind(report, "WorkerUnavailable");
    assert(finding?.severity === "warning", "a single non-monitoring worker being down produces a warning WorkerUnavailable finding");
    assert(report.summary === "Runtime operational with degraded workers.", `summary names "workers" as the degraded topic (got "${report.summary}")`);
  }

  // Multiple simultaneous worker failures (neither of which is the
  // monitoring worker) -> escalates to unhealthy per the "multiple worker
  // failures" rule, even though no single one of them is the monitoring
  // worker.
  {
    const status = healthyStatus({
      workers: [
        { id: "monitoring-worker", running: true },
        { id: "worker-a", running: false },
        { id: "worker-b", running: false },
      ],
    });
    const report = engine.diagnose(status);
    assert(report.health === "unhealthy", "two or more non-monitoring workers down simultaneously -> health: unhealthy (multiple worker failures)");
    const failures = report.findings.filter((finding) => finding.kind === "WorkerUnavailable");
    assert(failures.length === 2, "one WorkerUnavailable finding is reported per unavailable worker, not merged into one");
    assert(failures.every((finding) => finding.severity === "critical"), "each finding in a multiple-failure scenario is reported at critical severity");
  }

  // Monitoring stale: no monitoring cycle within the internal threshold,
  // despite the runtime running -> degraded, warning.
  {
    const status = healthyStatus({
      monitoring: { running: true, lastCycleAt: new Date(Date.now() - 2 * 60 * 60 * 1000), repositoriesMonitoredLastCycle: 2, repositoriesSkippedLastCycle: 0 },
    });
    const report = engine.diagnose(status);
    assert(report.health === "degraded", "no monitoring cycle in over the staleness threshold -> health: degraded");
    const finding = findKind(report, "MonitoringStale");
    assert(finding?.severity === "warning", "a stale monitoring cycle produces a warning MonitoringStale finding");
    assert(report.summary === "Runtime operational with degraded monitoring.", `summary names "monitoring" as the degraded topic (got "${report.summary}")`);
  }

  // Monitoring never ticked yet, but the runtime has been up for a long time
  // -> also stale (the "no lastCycleAt" branch of the staleness check).
  {
    const status = healthyStatus({
      runtime: { running: true, startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), uptimeMs: 2 * 60 * 60 * 1000 },
      monitoring: { running: true, lastCycleAt: undefined, repositoriesMonitoredLastCycle: 0, repositoriesSkippedLastCycle: 0 },
    });
    const report = engine.diagnose(status);
    assert(report.health === "degraded", "no monitoring cycle has EVER completed despite a long uptime -> health: degraded");
    assert(findKind(report, "MonitoringStale") !== undefined, "the no-lastCycleAt branch of staleness detection also produces a MonitoringStale finding");
  }

  // A freshly-started runtime with no monitoring cycle yet is NOT stale —
  // staleness must not fire just because lastCycleAt is undefined.
  {
    const status = healthyStatus({
      runtime: { running: true, startedAt: new Date(), uptimeMs: 500 },
      monitoring: { running: true, lastCycleAt: undefined, repositoriesMonitoredLastCycle: 0, repositoriesSkippedLastCycle: 0 },
    });
    const report = engine.diagnose(status);
    assert(report.health === "healthy", "a freshly-started runtime with no monitoring cycle yet is not considered stale");
    assert(!findKind(report, "MonitoringStale"), "no MonitoringStale finding for a runtime that simply hasn't had a chance to tick yet");
  }

  // Maintenance mode ALONE -> healthy, informational finding only. This is
  // the core "intentional state never reduces health" guarantee.
  {
    const status = healthyStatus({
      policy: {
        maintenanceMode: true,
        quietHoursActive: false,
        repositoriesDisabled: 0,
        repositoriesInCooldown: 0,
        globalNotificationBudget: { used: 0, max: 5, windowMs: 60 * 60 * 1000 },
      },
    });
    const report = engine.diagnose(status);
    assert(report.health === "healthy", "maintenance mode alone -> health: healthy");
    assert(report.summary === "Runtime healthy.", `maintenance mode alone -> summary is exactly "Runtime healthy." (got "${report.summary}")`);
    const finding = findKind(report, "MaintenanceModeActive");
    assert(finding?.severity === "info", "maintenance mode alone produces an info-severity MaintenanceModeActive finding");
  }

  // Quiet hours ALONE -> healthy, informational finding only.
  {
    const status = healthyStatus({
      policy: {
        maintenanceMode: false,
        quietHoursActive: true,
        repositoriesDisabled: 0,
        repositoriesInCooldown: 0,
        globalNotificationBudget: { used: 0, max: 5, windowMs: 60 * 60 * 1000 },
      },
    });
    const report = engine.diagnose(status);
    assert(report.health === "healthy", "quiet hours alone -> health: healthy");
    const finding = findKind(report, "QuietHoursActive");
    assert(finding?.severity === "info", "quiet hours alone produces an info-severity QuietHoursActive finding");
  }

  // Maintenance mode AND quiet hours together, nothing else anomalous ->
  // still healthy — the "never reduces health by itself" rule holds for any
  // combination of purely intentional-state findings.
  {
    const status = healthyStatus({
      policy: {
        maintenanceMode: true,
        quietHoursActive: true,
        repositoriesDisabled: 0,
        repositoriesInCooldown: 0,
        globalNotificationBudget: { used: 0, max: 5, windowMs: 60 * 60 * 1000 },
      },
    });
    const report = engine.diagnose(status);
    assert(report.health === "healthy", "maintenance mode + quiet hours together, no other anomaly -> health: healthy");
    assert(report.findings.length === 2, "both intentional-state findings are reported side by side");
  }

  // Notification budget exhausted -> degraded, warning.
  {
    const status = healthyStatus({
      policy: {
        maintenanceMode: false,
        quietHoursActive: false,
        repositoriesDisabled: 0,
        repositoriesInCooldown: 0,
        globalNotificationBudget: { used: 5, max: 5, windowMs: 60 * 60 * 1000 },
      },
    });
    const report = engine.diagnose(status);
    assert(report.health === "degraded", "global notification budget exhausted -> health: degraded");
    const finding = findKind(report, "NotificationBudgetExhausted");
    assert(finding?.severity === "warning", "budget exhaustion produces a warning NotificationBudgetExhausted finding");
    assert(finding?.message.includes("5/5"), "the finding message names the actual used/max figures");
  }

  // Repository monitoring disabled -> degraded, warning.
  {
    const status = healthyStatus({
      policy: {
        maintenanceMode: false,
        quietHoursActive: false,
        repositoriesDisabled: 2,
        repositoriesInCooldown: 0,
        globalNotificationBudget: { used: 0, max: 5, windowMs: 60 * 60 * 1000 },
      },
    });
    const report = engine.diagnose(status);
    assert(report.health === "degraded", "repositories with monitoring disabled -> health: degraded");
    const finding = findKind(report, "RepositoryMonitoringDisabled");
    assert(finding?.severity === "warning", "disabled repositories produce a warning RepositoryMonitoringDisabled finding");
    assert(report.summary === "Runtime operational with degraded repository coverage.", `summary names "repository coverage" as the degraded topic (got "${report.summary}")`);
  }

  // Repository cooldown active ALONE -> healthy, informational only — a
  // normal, expected, self-resolving consequence of recent delivery, not
  // evidence of a problem.
  {
    const status = healthyStatus({
      policy: {
        maintenanceMode: false,
        quietHoursActive: false,
        repositoriesDisabled: 0,
        repositoriesInCooldown: 3,
        globalNotificationBudget: { used: 0, max: 5, windowMs: 60 * 60 * 1000 },
      },
    });
    const report = engine.diagnose(status);
    assert(report.health === "healthy", "repositories in cooldown alone -> health: healthy");
    const finding = findKind(report, "RepositoryCooldownActive");
    assert(finding?.severity === "info", "repositories in cooldown produce an info-severity RepositoryCooldownActive finding");
  }

  // Multiple simultaneous anomalies -> unhealthy ceiling wins, every
  // relevant finding still present, summary reflects the unhealthy tier
  // rather than trying to enumerate everything.
  {
    const status = healthyStatus({
      runtime: { running: true, startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000), uptimeMs: 3 * 60 * 60 * 1000 },
      workers: [
        { id: "monitoring-worker", running: true },
        { id: "worker-a", running: false },
        { id: "worker-b", running: false },
      ],
      monitoring: { running: true, lastCycleAt: new Date(Date.now() - 3 * 60 * 60 * 1000), repositoriesMonitoredLastCycle: 1, repositoriesSkippedLastCycle: 1 },
      policy: {
        maintenanceMode: true,
        quietHoursActive: false,
        repositoriesDisabled: 1,
        repositoriesInCooldown: 1,
        globalNotificationBudget: { used: 5, max: 5, windowMs: 60 * 60 * 1000 },
      },
    });
    const report = engine.diagnose(status);
    assert(report.health === "unhealthy", "multiple simultaneous anomalies (2 worker failures + stale monitoring + exhausted budget + disabled repo) -> health: unhealthy");
    assert(report.summary === "Runtime unavailable.", `summary reflects the unhealthy ceiling regardless of how many findings exist (got "${report.summary}")`);
    assert(findKind(report, "WorkerUnavailable") !== undefined, "worker failures are still individually reported");
    assert(findKind(report, "MonitoringStale") !== undefined, "monitoring staleness is still reported");
    assert(findKind(report, "NotificationBudgetExhausted") !== undefined, "budget exhaustion is still reported");
    assert(findKind(report, "RepositoryMonitoringDisabled") !== undefined, "disabled repositories are still reported");
    assert(findKind(report, "MaintenanceModeActive") !== undefined, "the intentional maintenance-mode state is still reported for context, even though it isn't what caused the unhealthy verdict");
    assert(findKind(report, "RepositoryCooldownActive") !== undefined, "repository cooldown is still reported for context");
    assert(report.findings.length === 7, `every applicable finding is present exactly once (found ${report.findings.length})`);
  }

  // Determinism: the same RuntimeStatus, diagnosed twice, produces an
  // identical report (aside from generatedAt, which always reflects the
  // moment of that particular call — same convention as every other "report"
  // type in this codebase).
  {
    const status = healthyStatus({
      policy: {
        maintenanceMode: false,
        quietHoursActive: false,
        repositoriesDisabled: 1,
        repositoriesInCooldown: 2,
        globalNotificationBudget: { used: 3, max: 5, windowMs: 60 * 60 * 1000 },
      },
    });
    const first = engine.diagnose(status);
    const second = engine.diagnose(status);

    assert(first.health === second.health, "determinism: health verdict is identical across two calls with the same input");
    assert(first.summary === second.summary, "determinism: summary is identical across two calls with the same input");
    assert(JSON.stringify(first.findings) === JSON.stringify(second.findings), "determinism: findings are identical across two calls with the same input");

    // A second, independently-constructed engine instance must behave
    // identically too — there is no hidden per-instance state.
    const secondEngine = new RuntimeDiagnosticsEngine();
    const third = secondEngine.diagnose(status);
    assert(
      third.health === first.health && third.summary === first.summary && JSON.stringify(third.findings) === JSON.stringify(first.findings),
      "determinism: a second, independently-constructed RuntimeDiagnosticsEngine instance produces an identical report for the same input",
    );
  }

  // Constructor dependency check: RuntimeDiagnosticsEngine takes zero
  // constructor arguments — confirmed structurally (not just by convention)
  // by successfully constructing and using it with none.
  {
    const bareEngine = new RuntimeDiagnosticsEngine();
    const result = bareEngine.diagnose(healthyStatus());
    assert(result.health === "healthy", "RuntimeDiagnosticsEngine constructs with zero arguments and diagnoses correctly");
  }
}

main();
