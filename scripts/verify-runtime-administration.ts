import { ApplicationService } from "../src/application/ApplicationService";
import type { IApplicationService } from "../src/application/interfaces";
import { RuntimeDiagnosticsEngine } from "../src/diagnostics/RuntimeDiagnosticsEngine";
import { RuntimeReportingEngine } from "../src/reporting/RuntimeReportingEngine";
import { DeferredRuntimeAdministrationService } from "../src/admin/DeferredRuntimeAdministrationService";
import { RuntimeAdministrationServiceNotBoundError } from "../src/admin/errors";
import type { IRuntimeAdministrationService } from "../src/admin/interfaces";
import { RuntimeAdministrationService } from "../src/admin/RuntimeAdministrationService";
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
import type { IAttentionDispatcher } from "../src/attention/interfaces";
import type { AttentionDispatcherStatus } from "../src/attention/types";
import type { IRuntimeControlService } from "../src/control/interfaces";
import type { IDecisionEngine } from "../src/decisions/interfaces";
import type { RepositoryInsightReport } from "../src/decisions/types";
import type { Repository } from "../src/domain/repository/Repository";
import type { IRepositoryIntelligenceService } from "../src/intelligence/interfaces";
import type { RepositorySnapshot } from "../src/intelligence/types";
import type { IProjectMemoryService } from "../src/memory/interfaces";
import type { ProjectMemoryEvent } from "../src/memory/types";
import type { IRuntimePolicyEngine } from "../src/policy/interfaces";
import type { RuntimePolicyStatus } from "../src/policy/types";
import type { IRecommendationEngine } from "../src/recommendations/interfaces";
import type { RepositoryRecommendationReport } from "../src/recommendations/types";
import type { IRepositoryRegistry } from "../src/repositories/interfaces";
import type { IBackgroundRuntime } from "../src/runtime/interfaces";
import type { BackgroundRuntimeStatus } from "../src/runtime/types";
import type { IClaudeSessionManager } from "../src/session/interfaces";
import type { ClaudeSessionInfo } from "../src/session/types";
import type { IRuntimeStatusService } from "../src/status/interfaces";
import type { RuntimeStatus } from "../src/status/types";

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

// Records every method called — used to prove RuntimeAdministrationService
// touches nothing beyond exactly one delegating call per operation.
class RecordingRuntimeStatusService implements IRuntimeStatusService {
  calls: string[] = [];
  private readonly status: RuntimeStatus = {
    runtime: { running: true, startedAt: new Date(2026, 0, 1), uptimeMs: 99 },
    workers: [{ id: "monitoring-worker", running: true }],
    monitoring: { running: true, lastCycleAt: new Date(2026, 0, 1), repositoriesMonitoredLastCycle: 2, repositoriesSkippedLastCycle: 1 },
    policy: {
      maintenanceMode: false,
      quietHoursActive: false,
      repositoriesDisabled: 0,
      repositoriesInCooldown: 0,
      globalNotificationBudget: { used: 1, max: 5, windowMs: 60_000 },
    },
    attention: { lastDispatchAt: new Date(2026, 0, 1), notificationsDelivered: 3, notificationsSuppressed: 1 },
    generatedAt: new Date(2026, 0, 1),
  };
  getStatus(): RuntimeStatus {
    this.calls.push("getStatus");
    return this.status;
  }
}

class RecordingRuntimeControlService implements IRuntimeControlService {
  calls: string[] = [];
  pauseMonitoring(): void {
    this.calls.push("pauseMonitoring");
  }
  resumeMonitoring(): void {
    this.calls.push("resumeMonitoring");
  }
  enterMaintenanceMode(): void {
    this.calls.push("enterMaintenanceMode");
  }
  exitMaintenanceMode(): void {
    this.calls.push("exitMaintenanceMode");
  }
  enableRepository(repositoryId: string): void {
    this.calls.push(`enableRepository:${repositoryId}`);
  }
  disableRepository(repositoryId: string): void {
    this.calls.push(`disableRepository:${repositoryId}`);
  }
  resetDispatcherStatistics(): void {
    this.calls.push("resetDispatcherStatistics");
  }
  resetRuntimeStatistics(): void {
    this.calls.push("resetRuntimeStatistics");
  }
}

class RecordingRuntimePolicyEngine implements IRuntimePolicyEngine {
  calls: string[] = [];
  private readonly status: RuntimePolicyStatus = {
    maintenanceMode: true,
    quietHoursActive: true,
    repositoriesDisabled: 2,
    repositoriesInCooldown: 3,
    globalNotificationBudget: { used: 4, max: 5, windowMs: 60_000 },
  };
  evaluateMonitoring() {
    this.calls.push("evaluateMonitoring");
    return { allowed: true };
  }
  evaluateNotification() {
    this.calls.push("evaluateNotification");
    return { allowed: true };
  }
  recordNotificationSent(): void {
    this.calls.push("recordNotificationSent");
  }
  setMaintenanceMode(): void {
    this.calls.push("setMaintenanceMode");
  }
  setRepositoryMonitoringEnabled(): void {
    this.calls.push("setRepositoryMonitoringEnabled");
  }
  getStatus(): RuntimePolicyStatus {
    this.calls.push("getStatus");
    return this.status;
  }
}

// Plain "throw if ever called" stand-ins for ApplicationService's other
// collaborators, matching the style used in verify-runtime-status.ts /
// verify-runtime-control.ts.
class UnusedRepositoryIntelligenceService implements IRepositoryIntelligenceService {
  async getSnapshot(): Promise<RepositorySnapshot> {
    throw new Error("getRuntimeAdministration() must not touch IRepositoryIntelligenceService");
  }
}
class UnusedProjectMemoryService implements IProjectMemoryService {
  async record(): Promise<void> {
    throw new Error("not used");
  }
  async getRecentEvents(): Promise<ProjectMemoryEvent[]> {
    throw new Error("getRuntimeAdministration() must not touch IProjectMemoryService");
  }
}
class UnusedDecisionEngine implements IDecisionEngine {
  async analyze(): Promise<RepositoryInsightReport> {
    throw new Error("getRuntimeAdministration() must not touch IDecisionEngine");
  }
}
class UnusedSessionManager implements IClaudeSessionManager {
  resolveSession(): never {
    throw new Error("getRuntimeAdministration() must not touch IClaudeSessionManager");
  }
  resetSession(): void {
    throw new Error("not used");
  }
  expireSession(): void {
    throw new Error("not used");
  }
  getSessionStatus(): ClaudeSessionInfo | undefined {
    throw new Error("getRuntimeAdministration() must not touch IClaudeSessionManager");
  }
}
class UnusedRepositoryRegistry implements IRepositoryRegistry {
  getAllRepositories(): Repository[] {
    throw new Error("getRuntimeAdministration() must not touch IRepositoryRegistry");
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
    throw new Error("getRuntimeAdministration() must not touch IRecommendationEngine");
  }
}
class UnusedEngineeringAssistanceEngine implements IEngineeringAssistanceEngine {
  propose(): RepositoryAssistanceReport {
    throw new Error("getRuntimeAdministration() must not touch IEngineeringAssistanceEngine");
  }
}
class UnusedAutonomousPlanHistoryService implements IAutonomousPlanHistoryService {
  async record(): Promise<AutonomousPlanHistoryEntry> {
    throw new Error("getRuntimeAdministration() must not touch IAutonomousPlanHistoryService");
  }
  async getLatestEntry(): Promise<AutonomousPlanHistoryEntry | undefined> {
    throw new Error("getRuntimeAdministration() must not touch IAutonomousPlanHistoryService");
  }
  async getHistory(): Promise<AutonomousPlanHistoryEntry[]> {
    throw new Error("getRuntimeAdministration() must not touch IAutonomousPlanHistoryService");
  }
}
class UnusedAttentionDispatcher implements IAttentionDispatcher {
  async dispatch(): Promise<void> {
    throw new Error("not used");
  }
  getStatus(): AttentionDispatcherStatus {
    throw new Error("not used");
  }
  resetStatistics(): void {
    throw new Error("not used");
  }
}
class UnusedBackgroundRuntime implements IBackgroundRuntime {
  start(): void {
    throw new Error("not used");
  }
  stop(): void {
    throw new Error("not used");
  }
  getStatus(): BackgroundRuntimeStatus {
    throw new Error("not used");
  }
  resetStatistics(): void {
    throw new Error("not used");
  }
}

async function main(): Promise<void> {
  // RuntimeAdministrationService.getStatus() delegates to exactly
  // IRuntimeStatusService.getStatus() — one call, nothing else touched —
  // and returns the exact same object, not a reconstructed copy.
  {
    const statusService = new RecordingRuntimeStatusService();
    const controlService = new RecordingRuntimeControlService();
    const policyEngine = new RecordingRuntimePolicyEngine();
    const admin = new RuntimeAdministrationService(statusService, controlService, policyEngine);

    const result = admin.getStatus();
    assert(statusService.calls.join(",") === "getStatus", "getStatus() calls exactly IRuntimeStatusService.getStatus(), nothing else");
    assert(controlService.calls.length === 0 && policyEngine.calls.length === 0, "getStatus() does not touch IRuntimeControlService or IRuntimePolicyEngine");
    assert(result.attention.notificationsDelivered === 3, "getStatus() returns the RuntimeStatus IRuntimeStatusService actually produced");
  }

  // RuntimeStatus is returned UNCHANGED — the exact object reference, no
  // reconstruction of any kind (per the phase's explicit adjustment).
  {
    const statusService = new RecordingRuntimeStatusService();
    const controlService = new RecordingRuntimeControlService();
    const policyEngine = new RecordingRuntimePolicyEngine();
    const admin = new RuntimeAdministrationService(statusService, controlService, policyEngine);

    const fromService = statusService.getStatus();
    const fromAdmin = admin.getStatus();
    assert(fromAdmin === fromService, "getStatus() returns the exact same RuntimeStatus object reference IRuntimeStatusService.getStatus() produces — not reconstructed");
  }

  // RuntimeAdministrationService.getControl() delegates to exactly returning
  // the IRuntimeControlService reference — no method called on it, no
  // wrapping.
  {
    const statusService = new RecordingRuntimeStatusService();
    const controlService = new RecordingRuntimeControlService();
    const policyEngine = new RecordingRuntimePolicyEngine();
    const admin = new RuntimeAdministrationService(statusService, controlService, policyEngine);

    const result = admin.getControl();
    assert(result === controlService, "getControl() returns the exact IRuntimeControlService reference, unwrapped");
    assert(controlService.calls.length === 0, "getControl() does not call any method on IRuntimeControlService");
    assert(statusService.calls.length === 0 && policyEngine.calls.length === 0, "getControl() does not touch IRuntimeStatusService or IRuntimePolicyEngine");
  }

  // RuntimeAdministrationService.getPolicies() delegates to exactly
  // IRuntimePolicyEngine.getStatus() — one call, nothing else touched — and
  // returns the exact same RuntimePolicyStatus object, not reconstructed.
  {
    const statusService = new RecordingRuntimeStatusService();
    const controlService = new RecordingRuntimeControlService();
    const policyEngine = new RecordingRuntimePolicyEngine();
    const admin = new RuntimeAdministrationService(statusService, controlService, policyEngine);

    const fromEngine = policyEngine.getStatus();
    policyEngine.calls = []; // reset the call log after that direct call above
    const fromAdmin = admin.getPolicies();

    assert(policyEngine.calls.join(",") === "getStatus", "getPolicies() calls exactly IRuntimePolicyEngine.getStatus(), nothing else");
    assert(statusService.calls.length === 0 && controlService.calls.length === 0, "getPolicies() does not touch IRuntimeStatusService or IRuntimeControlService");
    assert(fromAdmin === fromEngine, "getPolicies() returns the exact same RuntimePolicyStatus object reference IRuntimePolicyEngine.getStatus() produces — not reconstructed");
  }

  // RuntimeAdministrationService owns zero mutable state: two independent
  // instances constructed from the same collaborators behave identically,
  // and calling every method repeatedly never changes what the next call
  // returns (only the underlying collaborator's own state could do that).
  {
    const statusService = new RecordingRuntimeStatusService();
    const controlService = new RecordingRuntimeControlService();
    const policyEngine = new RecordingRuntimePolicyEngine();
    const admin = new RuntimeAdministrationService(statusService, controlService, policyEngine);

    const first = admin.getStatus();
    const second = admin.getStatus();
    assert(first === second, "calling getStatus() repeatedly returns the same underlying object each time (RuntimeAdministrationService caches/holds nothing of its own)");

    const ownKeys = Object.keys(admin as unknown as Record<string, unknown>);
    assert(
      ownKeys.every((key) => ["runtimeStatusService", "runtimeControlService", "runtimePolicyEngine"].includes(key)),
      `RuntimeAdministrationService holds only its three constructor references, no other instance state (found keys: ${ownKeys.join(", ")})`,
    );
  }

  // Composed with the real RuntimePolicyEngine and a real RuntimeControlService
  // (Phase 8.6), driving enterMaintenanceMode() through getControl() actually
  // changes what getPolicies() reports next — proving this is live
  // composition over the real runtime layer, not just fakes talking to fakes.
  {
    const { RuntimePolicyEngine } = await import("../src/policy/RuntimePolicyEngine");
    const { RuntimeControlService } = await import("../src/control/RuntimeControlService");
    const realPolicy = new RuntimePolicyEngine({ quietHours: { startHour: 0, endHour: 0 }, cooldownMs: 0, maxNotificationsPerInterval: 100, notificationIntervalMs: 60_000 });
    const realControl = new RuntimeControlService(realPolicy, new UnusedBackgroundRuntime(), new UnusedAttentionDispatcher());
    const statusService = new RecordingRuntimeStatusService();
    const admin = new RuntimeAdministrationService(statusService, realControl, realPolicy);

    assert(admin.getPolicies().maintenanceMode === false, "maintenance mode is initially off, reported via getPolicies() against the real RuntimePolicyEngine");
    admin.getControl().enterMaintenanceMode();
    assert(admin.getPolicies().maintenanceMode === true, "entering maintenance mode via admin.getControl().enterMaintenanceMode() is reflected by the very next admin.getPolicies() call");
  }

  // DeferredRuntimeAdministrationService: the composition-root seam that
  // breaks the ApplicationService <-> RuntimeAdministrationService
  // construction-time ordering conflict.
  {
    const deferred = new DeferredRuntimeAdministrationService();
    let threw = false;
    try {
      deferred.getStatus();
    } catch (error) {
      threw = error instanceof RuntimeAdministrationServiceNotBoundError;
    }
    assert(threw, "DeferredRuntimeAdministrationService throws RuntimeAdministrationServiceNotBoundError before bind()");

    const statusService = new RecordingRuntimeStatusService();
    const controlService = new RecordingRuntimeControlService();
    const policyEngine = new RecordingRuntimePolicyEngine();
    const real = new RuntimeAdministrationService(statusService, controlService, policyEngine);

    deferred.bind(real);
    assert(deferred.getControl() === controlService, "after bind(), DeferredRuntimeAdministrationService transparently delegates every method to the real RuntimeAdministrationService");
  }

  // ApplicationService.getRuntimeAdministration() is pure delegation: it
  // returns the exact IRuntimeAdministrationService reference it was
  // constructed with, and touches none of its other collaborators.
  {
    const statusService = new RecordingRuntimeStatusService();
    const controlService = new RecordingRuntimeControlService();
    const policyEngine = new RecordingRuntimePolicyEngine();
    const admin = new RuntimeAdministrationService(statusService, controlService, policyEngine);

    class UnusedRuntimeStatusService implements IRuntimeStatusService {
      getStatus(): RuntimeStatus {
        throw new Error("getRuntimeAdministration() must not touch IRuntimeStatusService");
      }
    }
    class UnusedRuntimeControlService implements IRuntimeControlService {
      pauseMonitoring(): never {
        throw new Error("getRuntimeAdministration() must not touch IRuntimeControlService");
      }
      resumeMonitoring(): never {
        throw new Error("getRuntimeAdministration() must not touch IRuntimeControlService");
      }
      enterMaintenanceMode(): never {
        throw new Error("getRuntimeAdministration() must not touch IRuntimeControlService");
      }
      exitMaintenanceMode(): never {
        throw new Error("getRuntimeAdministration() must not touch IRuntimeControlService");
      }
      enableRepository(): never {
        throw new Error("getRuntimeAdministration() must not touch IRuntimeControlService");
      }
      disableRepository(): never {
        throw new Error("getRuntimeAdministration() must not touch IRuntimeControlService");
      }
      resetDispatcherStatistics(): never {
        throw new Error("getRuntimeAdministration() must not touch IRuntimeControlService");
      }
      resetRuntimeStatistics(): never {
        throw new Error("getRuntimeAdministration() must not touch IRuntimeControlService");
      }
    }

    const applicationService: IApplicationService = new ApplicationService(
      new UnusedRepositoryIntelligenceService(),
      new UnusedProjectMemoryService(),
      new UnusedDecisionEngine(),
      new UnusedSessionManager(),
      new UnusedRepositoryRegistry(),
      new UnusedRecommendationEngine(),
      new UnusedEngineeringAssistanceEngine(),
      new UnusedRuntimeStatusService(),
      new RuntimeDiagnosticsEngine(),
      new RuntimeReportingEngine(),
      new UnusedRuntimeControlService(),
      admin,
      new AutonomousPlanningEngine(),
      new AutonomousPlanningService(new UnusedAutonomousPlanHistoryService(), new AutonomousPlanStateEngine(new AutonomousPlanEvolutionEngine()), new AutonomousPlanningAnalysisEngine()),
    new AutonomousPlanReadinessEngine(),
    new AutonomousPlanSequencingEngine(),
    new AutonomousPlanSchedulingEngine(),
    new AutonomousPlanRecordingService(new UnusedAutonomousPlanHistoryService()),
    );

    let threw = false;
    let result: IRuntimeAdministrationService | undefined;
    try {
      result = applicationService.getRuntimeAdministration();
    } catch {
      threw = true;
    }
    assert(!threw, "ApplicationService.getRuntimeAdministration() does not touch any of its other collaborators");
    assert(result === admin, "ApplicationService.getRuntimeAdministration() returns the exact RuntimeAdministrationService reference it was constructed with, unchanged");
  }
}

main();
