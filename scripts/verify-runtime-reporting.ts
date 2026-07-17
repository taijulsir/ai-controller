import type { IApplicationService } from "../src/application/interfaces";
import { ApplicationService } from "../src/application/ApplicationService";
import type { IRuntimeAdministrationService } from "../src/admin/interfaces";
import { AutonomousPlanningEngine } from "../src/autonomy/AutonomousPlanningEngine";
import { AutonomousPlanEvolutionEngine } from "../src/planhistory/AutonomousPlanEvolutionEngine";
import type { IAutonomousPlanHistoryService } from "../src/planhistory/interfaces";
import type { AutonomousPlanHistoryEntry } from "../src/planhistory/types";
import { AutonomousPlanStateEngine } from "../src/planstate/AutonomousPlanStateEngine";
import { AutonomousPlanningService } from "../src/plan/AutonomousPlanningService";
import { AutonomousPlanningAnalysisEngine } from "../src/plananalysis/AutonomousPlanningAnalysisEngine";
import { AutonomousPlanReadinessEngine } from "../src/planreadiness/AutonomousPlanReadinessEngine";
import { AutonomousPlanRecordingService } from "../src/planrecording/AutonomousPlanRecordingService";
import { AutonomousPlanSequencingEngine } from "../src/plansequencing/AutonomousPlanSequencingEngine";
import { AutonomousPlanSchedulingEngine } from "../src/scheduling/AutonomousPlanSchedulingEngine";
import type { IEngineeringAssistanceEngine } from "../src/assistance/interfaces";
import type { RepositoryAssistanceReport } from "../src/assistance/types";
import type { IRuntimeControlService } from "../src/control/interfaces";
import type { IDecisionEngine } from "../src/decisions/interfaces";
import type { RepositoryInsightReport } from "../src/decisions/types";
import type { DiagnosticFinding, RuntimeDiagnosticsReport } from "../src/diagnostics/types";
import type { Repository } from "../src/domain/repository/Repository";
import type { IRepositoryIntelligenceService } from "../src/intelligence/interfaces";
import type { RepositorySnapshot } from "../src/intelligence/types";
import type { IProjectMemoryService } from "../src/memory/interfaces";
import type { ProjectMemoryEvent } from "../src/memory/types";
import type { IRecommendationEngine } from "../src/recommendations/interfaces";
import type { RepositoryRecommendationReport } from "../src/recommendations/types";
import type { IRepositoryRegistry } from "../src/repositories/interfaces";
import { RuntimeReportingEngine } from "../src/reporting/RuntimeReportingEngine";
import type { RuntimeReport } from "../src/reporting/types";
import type { WorkerStatus } from "../src/runtime/types";
import type { IClaudeSessionManager } from "../src/session/interfaces";
import type { ClaudeSessionInfo } from "../src/session/types";
import type { IRuntimeStatusService } from "../src/status/interfaces";
import type { RuntimeStatus } from "../src/status/types";

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

function finding(overrides: Partial<DiagnosticFinding> = {}): DiagnosticFinding {
  return { kind: "MaintenanceModeActive", severity: "info", message: "test message", ...overrides };
}

function healthyStatus(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    runtime: { running: true, startedAt: new Date(2026, 0, 1), uptimeMs: 3723 * 1000 }, // 1h 2m 3s
    workers: [{ id: "monitoring-worker", running: true }],
    monitoring: { running: true, lastCycleAt: new Date(2026, 0, 1, 12, 0, 0), repositoriesMonitoredLastCycle: 2, repositoriesSkippedLastCycle: 0 },
    policy: {
      maintenanceMode: false,
      quietHoursActive: false,
      repositoriesDisabled: 0,
      repositoriesInCooldown: 0,
      globalNotificationBudget: { used: 0, max: 5, windowMs: 60 * 60 * 1000 },
    },
    attention: { lastDispatchAt: undefined, notificationsDelivered: 0, notificationsSuppressed: 0 },
    generatedAt: new Date(2026, 0, 1),
    ...overrides,
  };
}

function healthyDiagnostics(overrides: Partial<RuntimeDiagnosticsReport> = {}): RuntimeDiagnosticsReport {
  return { health: "healthy", summary: "Runtime healthy.", findings: [], generatedAt: new Date(2026, 0, 1), ...overrides };
}

function section(report: RuntimeReport, title: string) {
  return report.sections.find((s) => s.title === title);
}

async function main(): Promise<void> {
  const engine = new RuntimeReportingEngine();

  // Healthy runtime: fixed title, verbatim health/summary, every section
  // present, correctly formatted values, and a "No findings." placeholder.
  {
    const report = engine.buildReport(healthyStatus(), healthyDiagnostics());
    assert(report.title === "AI Controller Runtime Report", `title is the fixed constant (got "${report.title}")`);
    assert(report.health === "healthy", "health is copied verbatim from RuntimeDiagnosticsReport");
    assert(report.summary === "Runtime healthy.", "summary is copied verbatim from RuntimeDiagnosticsReport");
    assert(report.generatedAt instanceof Date, "report carries its own generatedAt timestamp");
    assert(
      report.sections.map((s) => s.title).join(",") === "Runtime,Workers,Monitoring,Policy,Attention,Findings",
      `sections are present in the fixed order: Runtime, Workers, Monitoring, Policy, Attention, Findings (got "${report.sections.map((s) => s.title).join(",")}")`,
    );

    const runtimeSection = section(report, "Runtime");
    assert(runtimeSection?.lines.includes("Running: Yes"), "boolean true is rendered as 'Yes'");
    assert(runtimeSection?.lines.includes("Uptime: 1h 2m 3s"), `duration formatting renders 3723000ms as "1h 2m 3s" (got "${runtimeSection?.lines.join(" | ")}")`);

    const workersSection = section(report, "Workers");
    assert(workersSection?.lines.includes('Worker "monitoring-worker": running = Yes'), "worker running status is rendered with the worker id and Yes/No");

    const attentionSection = section(report, "Attention");
    assert(attentionSection?.lines.includes("Last dispatch: Never"), "an undefined date is rendered as 'Never'");

    const findingsSection = section(report, "Findings");
    assert(findingsSection?.lines.length === 1 && findingsSection.lines[0] === "No findings.", "zero findings renders a single 'No findings.' placeholder line");
  }

  // Degraded runtime: health/summary passed through verbatim, findings
  // rendered with severity, no reformatting of the diagnosis itself.
  {
    const diagnostics = healthyDiagnostics({
      health: "degraded",
      summary: "Runtime operational with degraded monitoring.",
      findings: [finding({ kind: "MonitoringStale", severity: "warning", message: "No monitoring cycle has completed since 2026-01-01T00:00:00.000Z, despite the runtime being active." })],
    });
    const report = engine.buildReport(healthyStatus(), diagnostics);
    assert(report.health === "degraded", "degraded health is passed through verbatim, not recomputed");
    assert(report.summary === "Runtime operational with degraded monitoring.", "degraded summary is passed through verbatim, not recomputed");
    const findingsSection = section(report, "Findings");
    assert(
      findingsSection?.lines[0] === "[warning] No monitoring cycle has completed since 2026-01-01T00:00:00.000Z, despite the runtime being active.",
      `finding is rendered as "[severity] message" with the message reused verbatim (got "${findingsSection?.lines[0]}")`,
    );
  }

  // Unhealthy runtime: same verbatim-passthrough guarantee at the unhealthy
  // tier, with a critical finding.
  {
    const diagnostics = healthyDiagnostics({
      health: "unhealthy",
      summary: "Runtime unavailable.",
      findings: [finding({ kind: "RuntimeStopped", severity: "critical", message: "The background runtime is not running — no monitoring or notification delivery can occur." })],
    });
    const status = healthyStatus({ runtime: { running: false, startedAt: undefined, uptimeMs: undefined } });
    const report = engine.buildReport(status, diagnostics);
    assert(report.health === "unhealthy", "unhealthy health is passed through verbatim");
    assert(report.summary === "Runtime unavailable.", "unhealthy summary is passed through verbatim");
    assert(section(report, "Runtime")?.lines.includes("Running: No"), "boolean false is rendered as 'No'");
    assert(section(report, "Runtime")?.lines.includes("Uptime: Never"), "undefined uptimeMs is rendered as 'Never'");
    const findingsSection = section(report, "Findings");
    assert(findingsSection?.lines[0]?.startsWith("[critical]"), "a critical finding is rendered with its own severity label, not upgraded/downgraded");
  }

  // Many findings: every finding is rendered, in order, none omitted, none
  // duplicated, none merged.
  {
    const findings = [
      finding({ kind: "RuntimeStopped", severity: "critical", message: "message A" }),
      finding({ kind: "WorkerUnavailable", severity: "critical", message: "message B" }),
      finding({ kind: "MonitoringStale", severity: "warning", message: "message C" }),
      finding({ kind: "MaintenanceModeActive", severity: "info", message: "message D" }),
      finding({ kind: "QuietHoursActive", severity: "info", message: "message E" }),
      finding({ kind: "NotificationBudgetExhausted", severity: "warning", message: "message F" }),
      finding({ kind: "RepositoryMonitoringDisabled", severity: "warning", message: "message G" }),
      finding({ kind: "RepositoryCooldownActive", severity: "info", message: "message H" }),
    ];
    const report = engine.buildReport(healthyStatus(), healthyDiagnostics({ findings }));
    const lines = section(report, "Findings")?.lines ?? [];
    assert(lines.length === findings.length, `every finding produces exactly one line, none omitted (expected ${findings.length}, got ${lines.length})`);
    assert(new Set(lines).size === lines.length, "no duplicated lines among the rendered findings");
    assert(
      lines.join("|") === findings.map((f) => `[${f.severity}] ${f.message}`).join("|"),
      "findings are rendered in the exact order RuntimeDiagnosticsReport produced them",
    );
  }

  // Many workers: every worker is rendered, in order, with correct
  // running/not-running labeling, none omitted, none duplicated.
  {
    const workers: WorkerStatus[] = [
      { id: "monitoring-worker", running: true },
      { id: "worker-a", running: false },
      { id: "worker-b", running: true },
      { id: "worker-c", running: false },
      { id: "worker-d", running: true },
    ];
    const report = engine.buildReport(healthyStatus({ workers }), healthyDiagnostics());
    const lines = section(report, "Workers")?.lines ?? [];
    assert(lines.length === workers.length, `every worker produces exactly one line, none omitted (expected ${workers.length}, got ${lines.length})`);
    assert(new Set(lines).size === lines.length, "no duplicated lines among the rendered workers");
    assert(
      lines.join("|") === workers.map((w) => `Worker "${w.id}": running = ${w.running ? "Yes" : "No"}`).join("|"),
      "workers are rendered in the exact order RuntimeStatus produced them, each with the correct Yes/No",
    );
  }

  // Many disabled repositories: the count is rendered directly, not
  // reinterpreted or judged.
  {
    const status = healthyStatus({
      policy: {
        maintenanceMode: false,
        quietHoursActive: false,
        repositoriesDisabled: 12,
        repositoriesInCooldown: 7,
        globalNotificationBudget: { used: 2, max: 5, windowMs: 60 * 60 * 1000 },
      },
    });
    const report = engine.buildReport(status, healthyDiagnostics());
    const policySection = section(report, "Policy");
    assert(policySection?.lines.includes("Repositories disabled: 12"), "a large disabled-repository count is rendered verbatim, unmodified");
    assert(policySection?.lines.includes("Repositories in cooldown: 7"), "a large cooldown count is rendered verbatim, unmodified");
    assert(policySection?.lines.includes("Notification budget: 2/5"), "the notification budget is rendered as used/max");
  }

  // Deterministic section order and line order: rebuilding the report from
  // the same inputs multiple times never reorders anything.
  {
    const status = healthyStatus({
      workers: [
        { id: "monitoring-worker", running: true },
        { id: "worker-a", running: false },
      ],
    });
    const diagnostics = healthyDiagnostics({
      health: "degraded",
      findings: [finding({ message: "first" }), finding({ message: "second" }), finding({ message: "third" })],
    });

    const first = engine.buildReport(status, diagnostics);
    const second = engine.buildReport(status, diagnostics);

    assert(
      first.sections.map((s) => s.title).join(",") === second.sections.map((s) => s.title).join(","),
      "section order is identical across repeated calls with the same input",
    );
    assert(
      JSON.stringify(first.sections.map((s) => s.lines)) === JSON.stringify(second.sections.map((s) => s.lines)),
      "line order within every section is identical across repeated calls with the same input",
    );
    assert(first.health === second.health && first.summary === second.summary, "health and summary are identical across repeated calls with the same input");

    const thirdEngine = new RuntimeReportingEngine();
    const third = thirdEngine.buildReport(status, diagnostics);
    assert(
      JSON.stringify(third.sections) === JSON.stringify(first.sections),
      "a second, independently-constructed RuntimeReportingEngine instance produces an identical report for the same input",
    );
  }

  // Reporting must never perform runtime analysis: feeding it a status/
  // diagnostics pair whose diagnosis contradicts the raw status (impossible
  // in real use, but a strong test of "no analysis happens here") proves
  // the engine renders exactly what it's told, never re-deriving health or
  // severity itself.
  {
    const contradictoryStatus = healthyStatus({ runtime: { running: false, startedAt: undefined, uptimeMs: undefined } });
    const contradictoryDiagnostics = healthyDiagnostics({ health: "healthy", summary: "Runtime healthy.", findings: [] });
    const report = engine.buildReport(contradictoryStatus, contradictoryDiagnostics);
    assert(report.health === "healthy", "the engine trusts the supplied RuntimeDiagnosticsReport.health verbatim, even against a contradictory RuntimeStatus — it never re-derives health itself");
    assert(section(report, "Runtime")?.lines.includes("Running: No"), "the Runtime section still faithfully reports the raw status value, independent of the diagnosis");
  }

  // Plain "throw if ever called" stand-ins for ApplicationService's other
  // collaborators, matching the style used in the sibling verify-runtime-*
  // scripts.
  class UnusedRepositoryIntelligenceService implements IRepositoryIntelligenceService {
    async getSnapshot(): Promise<RepositorySnapshot> {
      throw new Error("not used");
    }
  }
  class UnusedProjectMemoryService implements IProjectMemoryService {
    async record(): Promise<void> {
      throw new Error("not used");
    }
    async getRecentEvents(): Promise<ProjectMemoryEvent[]> {
      throw new Error("not used");
    }
  }
  class UnusedDecisionEngine implements IDecisionEngine {
    async analyze(): Promise<RepositoryInsightReport> {
      throw new Error("not used");
    }
  }
  class UnusedSessionManager implements IClaudeSessionManager {
    resolveSession(): never {
      throw new Error("not used");
    }
    resetSession(): void {
      throw new Error("not used");
    }
    expireSession(): void {
      throw new Error("not used");
    }
    getSessionStatus(): ClaudeSessionInfo | undefined {
      throw new Error("not used");
    }
  }
  class UnusedRepositoryRegistry implements IRepositoryRegistry {
    getAllRepositories(): Repository[] {
      throw new Error("not used");
    }
    getRepository(): Repository {
      throw new Error("not used");
    }
    getActiveRepository(): Repository | undefined {
      throw new Error("not used");
    }
    setActiveRepository(): void {
      throw new Error("not used");
    }
    repositoryExists(): boolean {
      throw new Error("not used");
    }
    refresh(): void {
      throw new Error("not used");
    }
  }
  class UnusedRecommendationEngine implements IRecommendationEngine {
    recommend(): RepositoryRecommendationReport {
      throw new Error("not used");
    }
  }
  class UnusedEngineeringAssistanceEngine implements IEngineeringAssistanceEngine {
    propose(): RepositoryAssistanceReport {
      throw new Error("not used");
    }
  }
  class UnusedRuntimeControlService implements IRuntimeControlService {
    pauseMonitoring(): never {
      throw new Error("not used");
    }
    resumeMonitoring(): never {
      throw new Error("not used");
    }
    enterMaintenanceMode(): never {
      throw new Error("not used");
    }
    exitMaintenanceMode(): never {
      throw new Error("not used");
    }
    enableRepository(): never {
      throw new Error("not used");
    }
    disableRepository(): never {
      throw new Error("not used");
    }
    resetDispatcherStatistics(): never {
      throw new Error("not used");
    }
    resetRuntimeStatistics(): never {
      throw new Error("not used");
    }
  }
  class UnusedRuntimeAdministrationService implements IRuntimeAdministrationService {
    getStatus(): RuntimeStatus {
      throw new Error("not used");
    }
    getControl(): IRuntimeControlService {
      throw new Error("not used");
    }
    getPolicies() {
      throw new Error("not used");
    }
  }
  class UnusedAutonomousPlanHistoryService implements IAutonomousPlanHistoryService {
    async record(): Promise<AutonomousPlanHistoryEntry> {
      throw new Error("not used");
    }
    async getLatestEntry(): Promise<AutonomousPlanHistoryEntry | undefined> {
      throw new Error("not used");
    }
    async getHistory(): Promise<AutonomousPlanHistoryEntry[]> {
      throw new Error("not used");
    }
  }

  // Records every call — used to prove ApplicationService.getRuntimeReport()
  // fetches RuntimeStatus exactly once (never twice, and never via
  // getRuntimeDiagnosis()'s own independent fetch).
  class RecordingRuntimeStatusService implements IRuntimeStatusService {
    calls = 0;
    private readonly status = healthyStatus();
    getStatus(): RuntimeStatus {
      this.calls += 1;
      return this.status;
    }
  }
  class RecordingRuntimeDiagnosticsEngine {
    calls: RuntimeStatus[] = [];
    diagnose(status: RuntimeStatus): RuntimeDiagnosticsReport {
      this.calls.push(status);
      return healthyDiagnostics();
    }
  }
  class RecordingRuntimeReportingEngine {
    calls: { status: RuntimeStatus; diagnostics: RuntimeDiagnosticsReport }[] = [];
    buildReport(status: RuntimeStatus, diagnostics: RuntimeDiagnosticsReport): RuntimeReport {
      this.calls.push({ status, diagnostics });
      return { title: "AI Controller Runtime Report", health: diagnostics.health, summary: diagnostics.summary, sections: [], generatedAt: new Date() };
    }
  }

  // ApplicationService.getRuntimeReport() fetches RuntimeStatus exactly
  // once and reuses that exact same object for both diagnose() and
  // buildReport() — never calling getRuntimeDiagnosis() (which would fetch
  // a second, independent snapshot).
  {
    const statusService = new RecordingRuntimeStatusService();
    const diagnosticsEngine = new RecordingRuntimeDiagnosticsEngine();
    const reportingEngine = new RecordingRuntimeReportingEngine();

    const applicationService: IApplicationService = new ApplicationService(
      new UnusedRepositoryIntelligenceService(),
      new UnusedProjectMemoryService(),
      new UnusedDecisionEngine(),
      new UnusedSessionManager(),
      new UnusedRepositoryRegistry(),
      new UnusedRecommendationEngine(),
      new UnusedEngineeringAssistanceEngine(),
      statusService,
      diagnosticsEngine,
      reportingEngine,
      new UnusedRuntimeControlService(),
      new UnusedRuntimeAdministrationService(),
      new AutonomousPlanningEngine(),
      new AutonomousPlanningService(new UnusedAutonomousPlanHistoryService(), new AutonomousPlanStateEngine(new AutonomousPlanEvolutionEngine()), new AutonomousPlanningAnalysisEngine()),
    new AutonomousPlanReadinessEngine(),
    new AutonomousPlanSequencingEngine(),
    new AutonomousPlanSchedulingEngine(),
    new AutonomousPlanRecordingService(new UnusedAutonomousPlanHistoryService()),
    );

    applicationService.getRuntimeReport();

    assert(statusService.calls === 1, `RuntimeStatusService.getStatus() is called exactly once by getRuntimeReport() (observed ${statusService.calls} calls)`);
    assert(diagnosticsEngine.calls.length === 1, "RuntimeDiagnosticsEngine.diagnose() is called exactly once");
    assert(reportingEngine.calls.length === 1, "RuntimeReportingEngine.buildReport() is called exactly once");
    assert(
      diagnosticsEngine.calls[0] === reportingEngine.calls[0]?.status,
      "the exact same RuntimeStatus object instance is passed to both diagnose() and buildReport() — not two independently-fetched snapshots",
    );
  }
}

main();
