import { ApplicationService } from "../src/application/ApplicationService";
import type { IApplicationService } from "../src/application/interfaces";
import type { IEngineeringAssistanceEngine } from "../src/assistance/interfaces";
import { RuntimeDiagnosticsEngine } from "../src/diagnostics/RuntimeDiagnosticsEngine";
import { RuntimeReportingEngine } from "../src/reporting/RuntimeReportingEngine";
import { AutonomousPlanningEngine } from "../src/autonomy/AutonomousPlanningEngine";
import { AutonomousPlanEvolutionEngine } from "../src/planhistory/AutonomousPlanEvolutionEngine";
import type { IAutonomousPlanHistoryService } from "../src/planhistory/interfaces";
import type { AutonomousPlanHistoryEntry } from "../src/planhistory/types";
import { AutonomousPlanStateEngine } from "../src/planstate/AutonomousPlanStateEngine";
import { AutonomousPlanningService } from "../src/plan/AutonomousPlanningService";
import type { RepositoryAssistanceReport } from "../src/assistance/types";
import type { IRuntimeAdministrationService } from "../src/admin/interfaces";
import { AttentionDispatcher } from "../src/attention/AttentionDispatcher";
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
import type { IProactiveMonitor } from "../src/monitoring/interfaces";
import type { AttentionEvent } from "../src/monitoring/types";
import type { IRuntimePolicyEngine } from "../src/policy/interfaces";
import type { RuntimePolicyStatus } from "../src/policy/types";
import type { IRecommendationEngine } from "../src/recommendations/interfaces";
import type { RepositoryRecommendationReport } from "../src/recommendations/types";
import type { IRepositoryRegistry } from "../src/repositories/interfaces";
import { BackgroundRuntime } from "../src/runtime/BackgroundRuntime";
import type { IBackgroundRuntime } from "../src/runtime/interfaces";
import { MonitoringWorker } from "../src/runtime/MonitoringWorker";
import type { BackgroundRuntimeStatus } from "../src/runtime/types";
import type { IClaudeSessionManager } from "../src/session/interfaces";
import type { ClaudeSessionInfo } from "../src/session/types";
import { DeferredRuntimeStatusService } from "../src/status/DeferredRuntimeStatusService";
import { RuntimeStatusServiceNotBoundError } from "../src/status/errors";
import type { IRuntimeStatusService } from "../src/status/interfaces";
import { RuntimeStatusService } from "../src/status/RuntimeStatusService";
import type { RuntimeStatus } from "../src/status/types";
import type { EngineeringWorkspace } from "../src/workspace/types";

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function repository(id: string): Repository {
  return { id, name: id, path: `/repos/${id}`, defaultBranch: "main", active: false };
}

// Records every method called on it — used to assert RuntimeStatusService
// never calls anything beyond getStatus() on any of its four collaborators.
class RecordingBackgroundRuntime implements IBackgroundRuntime {
  calls: string[] = [];
  private readonly status: BackgroundRuntimeStatus = {
    running: true,
    startedAt: new Date(2026, 0, 1),
    uptimeMs: 1234,
    workers: [{ id: "monitoring-worker", running: true }],
  };
  start(): void {
    this.calls.push("start");
  }
  stop(): void {
    this.calls.push("stop");
  }
  getStatus(): BackgroundRuntimeStatus {
    this.calls.push("getStatus");
    return this.status;
  }
  resetStatistics(): void {
    this.calls.push("resetStatistics");
  }
}

class RecordingAttentionDispatcher implements IAttentionDispatcher {
  calls: string[] = [];
  private readonly status: AttentionDispatcherStatus = {
    lastDispatchAt: new Date(2026, 0, 1),
    notificationsDelivered: 3,
    notificationsSuppressed: 2,
  };
  async dispatch(): Promise<void> {
    this.calls.push("dispatch");
  }
  getStatus(): AttentionDispatcherStatus {
    this.calls.push("getStatus");
    return this.status;
  }
  resetStatistics(): void {
    this.calls.push("resetStatistics");
  }
}

class RecordingRuntimePolicyEngine implements IRuntimePolicyEngine {
  calls: string[] = [];
  private readonly status: RuntimePolicyStatus = {
    maintenanceMode: true,
    quietHoursActive: false,
    repositoriesDisabled: 1,
    repositoriesInCooldown: 2,
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

// A policy that genuinely denies notifications, to drive real suppressed-
// count activity through a real AttentionDispatcher in the "reflects genuine
// activity" test below.
class DenyingRuntimePolicyEngine implements IRuntimePolicyEngine {
  evaluateMonitoring() {
    return { allowed: true } as const;
  }
  evaluateNotification() {
    return { allowed: false, reason: "cooldown" } as const;
  }
  recordNotificationSent(): void {}
  setMaintenanceMode(): void {}
  setRepositoryMonitoringEnabled(): void {}
  getStatus(): RuntimePolicyStatus {
    return {
      maintenanceMode: false,
      quietHoursActive: false,
      repositoriesDisabled: 0,
      repositoriesInCooldown: 0,
      globalNotificationBudget: { used: 0, max: 0, windowMs: 0 },
    };
  }
}

class FakeRepositoryRegistry implements IRepositoryRegistry {
  constructor(private readonly repositories: Repository[]) {}
  getAllRepositories(): Repository[] {
    return this.repositories;
  }
  getRepository(id: string): Repository {
    const found = this.repositories.find((repo) => repo.id === id);
    if (!found) throw new Error(`not used: ${id}`);
    return found;
  }
  getActiveRepository(): Repository | undefined {
    return this.repositories.find((repo) => repo.active);
  }
  setActiveRepository(): void {
    throw new Error("not used");
  }
  repositoryExists(id: string): boolean {
    return this.repositories.some((repo) => repo.id === id);
  }
  refresh(): void {
    throw new Error("not used");
  }
}

class FakeProactiveMonitor implements IProactiveMonitor {
  async evaluate(): Promise<AttentionEvent[]> {
    return [];
  }
}

// Plain "throw if ever called" stand-ins for the seven ApplicationService
// collaborators that getRuntimeStatus() must never touch.
class UnusedRepositoryIntelligenceService implements IRepositoryIntelligenceService {
  async getSnapshot(): Promise<RepositorySnapshot> {
    throw new Error("getRuntimeStatus() must not touch IRepositoryIntelligenceService");
  }
}
class UnusedProjectMemoryService implements IProjectMemoryService {
  async record(): Promise<void> {
    throw new Error("not used");
  }
  async getRecentEvents(): Promise<ProjectMemoryEvent[]> {
    throw new Error("getRuntimeStatus() must not touch IProjectMemoryService");
  }
}
class UnusedDecisionEngine implements IDecisionEngine {
  async analyze(): Promise<RepositoryInsightReport> {
    throw new Error("getRuntimeStatus() must not touch IDecisionEngine");
  }
}
class UnusedSessionManager implements IClaudeSessionManager {
  resolveSession(): never {
    throw new Error("getRuntimeStatus() must not touch IClaudeSessionManager");
  }
  resetSession(): void {
    throw new Error("not used");
  }
  expireSession(): void {
    throw new Error("not used");
  }
  getSessionStatus(): ClaudeSessionInfo | undefined {
    throw new Error("getRuntimeStatus() must not touch IClaudeSessionManager");
  }
}
class UnusedRepositoryRegistry implements IRepositoryRegistry {
  getAllRepositories(): Repository[] {
    throw new Error("getRuntimeStatus() must not touch IRepositoryRegistry");
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
    throw new Error("getRuntimeStatus() must not touch IRecommendationEngine");
  }
}
class UnusedEngineeringAssistanceEngine implements IEngineeringAssistanceEngine {
  propose(): RepositoryAssistanceReport {
    throw new Error("getRuntimeStatus() must not touch IEngineeringAssistanceEngine");
  }
}
class UnusedRuntimeControlService implements IRuntimeControlService {
  pauseMonitoring(): never {
    throw new Error("getRuntimeStatus() must not touch IRuntimeControlService");
  }
  resumeMonitoring(): never {
    throw new Error("getRuntimeStatus() must not touch IRuntimeControlService");
  }
  enterMaintenanceMode(): never {
    throw new Error("getRuntimeStatus() must not touch IRuntimeControlService");
  }
  exitMaintenanceMode(): never {
    throw new Error("getRuntimeStatus() must not touch IRuntimeControlService");
  }
  enableRepository(): never {
    throw new Error("getRuntimeStatus() must not touch IRuntimeControlService");
  }
  disableRepository(): never {
    throw new Error("getRuntimeStatus() must not touch IRuntimeControlService");
  }
  resetDispatcherStatistics(): never {
    throw new Error("getRuntimeStatus() must not touch IRuntimeControlService");
  }
  resetRuntimeStatistics(): never {
    throw new Error("getRuntimeStatus() must not touch IRuntimeControlService");
  }
}
class UnusedRuntimeAdministrationService implements IRuntimeAdministrationService {
  getStatus(): RuntimeStatus {
    throw new Error("getRuntimeStatus() must not touch IRuntimeAdministrationService");
  }
  getControl(): IRuntimeControlService {
    throw new Error("getRuntimeStatus() must not touch IRuntimeAdministrationService");
  }
  getPolicies(): RuntimePolicyStatus {
    throw new Error("getRuntimeStatus() must not touch IRuntimeAdministrationService");
  }
}
class UnusedAutonomousPlanHistoryService implements IAutonomousPlanHistoryService {
  async record(): Promise<AutonomousPlanHistoryEntry> {
    throw new Error("getRuntimeStatus() must not touch IAutonomousPlanHistoryService");
  }
  async getLatestEntry(): Promise<AutonomousPlanHistoryEntry | undefined> {
    throw new Error("getRuntimeStatus() must not touch IAutonomousPlanHistoryService");
  }
  async getHistory(): Promise<AutonomousPlanHistoryEntry[]> {
    throw new Error("getRuntimeStatus() must not touch IAutonomousPlanHistoryService");
  }
}

async function main(): Promise<void> {
  // RuntimeStatusService assembles all five sections from exactly the four
  // collaborators' own getStatus() output — no recomputation, no additional
  // fields invented along the way.
  {
    const backgroundRuntime = new RecordingBackgroundRuntime();
    const attentionDispatcher = new RecordingAttentionDispatcher();
    const runtimePolicy = new RecordingRuntimePolicyEngine();
    const registry = new FakeRepositoryRegistry([repository("alpha")]);
    const monitor = new FakeProactiveMonitor();
    const monitoringWorker = new MonitoringWorker(monitor, registry, attentionDispatcher, runtimePolicy, 20);

    const service = new RuntimeStatusService(backgroundRuntime, monitoringWorker, attentionDispatcher, runtimePolicy);
    const status = service.getStatus();

    assert(status.runtime.running === true && status.runtime.uptimeMs === 1234, "runtime section is copied directly from BackgroundRuntime.getStatus()");
    assert(status.workers.length === 1 && status.workers[0]?.id === "monitoring-worker", "workers section is copied directly from BackgroundRuntime.getStatus()");
    assert(status.policy.maintenanceMode === true && status.policy.globalNotificationBudget.used === 4, "policy section is copied directly from RuntimePolicyEngine.getStatus()");
    assert(status.attention.notificationsDelivered === 3 && status.attention.notificationsSuppressed === 2, "attention section is copied directly from AttentionDispatcher.getStatus()");
    assert(status.generatedAt instanceof Date, "the snapshot carries a generatedAt timestamp");
  }

  // RuntimeStatusService never calls anything beyond getStatus() on any of
  // its four collaborators — no start(), stop(), dispatch(), evaluate*(),
  // setMaintenanceMode(), setRepositoryMonitoringEnabled(), or
  // recordNotificationSent().
  {
    const backgroundRuntime = new RecordingBackgroundRuntime();
    const attentionDispatcher = new RecordingAttentionDispatcher();
    const runtimePolicy = new RecordingRuntimePolicyEngine();
    const registry = new FakeRepositoryRegistry([repository("alpha")]);
    const monitor = new FakeProactiveMonitor();
    const monitoringWorker = new MonitoringWorker(monitor, registry, attentionDispatcher, runtimePolicy, 20);

    const service = new RuntimeStatusService(backgroundRuntime, monitoringWorker, attentionDispatcher, runtimePolicy);
    service.getStatus();

    assert(backgroundRuntime.calls.join(",") === "getStatus", "RuntimeStatusService performs zero mutations on BackgroundRuntime — only getStatus() is called");
    assert(attentionDispatcher.calls.join(",") === "getStatus", "RuntimeStatusService performs zero mutations on AttentionDispatcher — only getStatus() is called");
    assert(runtimePolicy.calls.join(",") === "getStatus", "RuntimeStatusService performs zero mutations on RuntimePolicyEngine — only getStatus() is called");
  }

  // Every component's getStatus() reflects genuine runtime activity when
  // driven through real behavior, not fakes echoing canned values: a real
  // MonitoringWorker ticks against two repositories, a real
  // AttentionDispatcher dispatches (denied by policy here, to also exercise
  // a real suppressed-notification count), assembled into one real snapshot.
  {
    const policy = new DenyingRuntimePolicyEngine();
    const realDispatcher = new AttentionDispatcher(policy);
    const registry = new FakeRepositoryRegistry([repository("alpha"), repository("beta")]);
    const monitor = new FakeProactiveMonitor();
    const monitoringWorker = new MonitoringWorker(monitor, registry, realDispatcher, policy, 20);
    const realRuntime = new BackgroundRuntime([monitoringWorker]);

    realRuntime.start();
    await delay(30);
    realRuntime.stop();

    const service = new RuntimeStatusService(realRuntime, monitoringWorker, realDispatcher, policy);
    const status = service.getStatus();

    assert(status.monitoring.repositoriesMonitoredLastCycle === 2, "monitoring section reflects a real tick's repository count, not a canned value");
    assert(status.monitoring.lastCycleAt instanceof Date, "monitoring section carries a real lastCycleAt from the driven tick");
    assert(status.runtime.running === false, "runtime section reflects that the real BackgroundRuntime was stopped before the snapshot was taken");
  }

  // DeferredRuntimeStatusService: the composition-root seam that breaks the
  // ApplicationService <-> RuntimeStatusService construction-time cycle.
  {
    const deferred = new DeferredRuntimeStatusService();
    let threw = false;
    try {
      deferred.getStatus();
    } catch (error) {
      threw = error instanceof RuntimeStatusServiceNotBoundError;
    }
    assert(threw, "DeferredRuntimeStatusService.getStatus() throws RuntimeStatusServiceNotBoundError before bind()");

    const backgroundRuntime = new RecordingBackgroundRuntime();
    const attentionDispatcher = new RecordingAttentionDispatcher();
    const runtimePolicyEngine = new RecordingRuntimePolicyEngine();
    const registry = new FakeRepositoryRegistry([repository("alpha")]);
    const monitor = new FakeProactiveMonitor();
    const monitoringWorker = new MonitoringWorker(monitor, registry, attentionDispatcher, runtimePolicyEngine, 20);
    const real = new RuntimeStatusService(backgroundRuntime, monitoringWorker, attentionDispatcher, runtimePolicyEngine);

    deferred.bind(real);
    const status = deferred.getStatus();
    assert(status.policy.maintenanceMode === true, "after bind(), DeferredRuntimeStatusService transparently delegates to the real RuntimeStatusService");
  }

  // ApplicationService.getRuntimeStatus() is pure delegation: it returns
  // exactly what RuntimeStatusService.getStatus() produces, unchanged, and
  // touches none of ApplicationService's other six collaborators.
  {
    const canned: RuntimeStatus = {
      runtime: { running: true, startedAt: new Date(2026, 0, 1), uptimeMs: 42 },
      workers: [{ id: "monitoring-worker", running: true }],
      monitoring: { running: true, lastCycleAt: new Date(2026, 0, 1), repositoriesMonitoredLastCycle: 1, repositoriesSkippedLastCycle: 0 },
      policy: {
        maintenanceMode: false,
        quietHoursActive: false,
        repositoriesDisabled: 0,
        repositoriesInCooldown: 0,
        globalNotificationBudget: { used: 0, max: 5, windowMs: 60_000 },
      },
      attention: { lastDispatchAt: undefined, notificationsDelivered: 0, notificationsSuppressed: 0 },
      generatedAt: new Date(2026, 0, 1),
    };
    class StubRuntimeStatusService implements IRuntimeStatusService {
      getStatus(): RuntimeStatus {
        return canned;
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
      new StubRuntimeStatusService(),
      new RuntimeDiagnosticsEngine(),
      new RuntimeReportingEngine(),
      new UnusedRuntimeControlService(),
      new UnusedRuntimeAdministrationService(),
      new AutonomousPlanningEngine(),
      new AutonomousPlanningService(new UnusedAutonomousPlanHistoryService(), new AutonomousPlanStateEngine(new AutonomousPlanEvolutionEngine())),
    );

    let threw = false;
    let result: RuntimeStatus | undefined;
    try {
      result = applicationService.getRuntimeStatus();
    } catch {
      threw = true;
    }
    assert(!threw, "ApplicationService.getRuntimeStatus() does not touch any of its other six collaborators");
    assert(result === canned, "ApplicationService.getRuntimeStatus() returns exactly what RuntimeStatusService.getStatus() produced, unchanged");
  }
}

main();
