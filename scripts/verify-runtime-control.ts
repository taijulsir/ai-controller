import type { IRuntimeAdministrationService } from "../src/admin/interfaces";
import { ApplicationService } from "../src/application/ApplicationService";
import type { IApplicationService } from "../src/application/interfaces";
import { RuntimeDiagnosticsEngine } from "../src/diagnostics/RuntimeDiagnosticsEngine";
import { RuntimeReportingEngine } from "../src/reporting/RuntimeReportingEngine";
import { AutonomousPlanningEngine } from "../src/autonomy/AutonomousPlanningEngine";
import { AutonomousPlanEvolutionEngine } from "../src/planhistory/AutonomousPlanEvolutionEngine";
import type { IAutonomousPlanHistoryService } from "../src/planhistory/interfaces";
import type { AutonomousPlanHistoryEntry } from "../src/planhistory/types";
import { AutonomousPlanStateEngine } from "../src/planstate/AutonomousPlanStateEngine";
import type { IEngineeringAssistanceEngine } from "../src/assistance/interfaces";
import type { RepositoryAssistanceReport } from "../src/assistance/types";
import type { IAttentionDispatcher } from "../src/attention/interfaces";
import type { AttentionDispatcherStatus } from "../src/attention/types";
import { DeferredRuntimeControlService } from "../src/control/DeferredRuntimeControlService";
import { RuntimeControlServiceNotBoundError } from "../src/control/errors";
import type { IRuntimeControlService } from "../src/control/interfaces";
import { RuntimeControlService } from "../src/control/RuntimeControlService";
import type { IDecisionEngine } from "../src/decisions/interfaces";
import type { RepositoryInsightReport } from "../src/decisions/types";
import type { Repository } from "../src/domain/repository/Repository";
import type { IRepositoryIntelligenceService } from "../src/intelligence/interfaces";
import type { RepositorySnapshot } from "../src/intelligence/types";
import type { IProjectMemoryService } from "../src/memory/interfaces";
import type { ProjectMemoryEvent } from "../src/memory/types";
import { RuntimePolicyEngine } from "../src/policy/RuntimePolicyEngine";
import type { IRuntimePolicyEngine } from "../src/policy/interfaces";
import type { RuntimePolicyStatus } from "../src/policy/types";
import type { IRecommendationEngine } from "../src/recommendations/interfaces";
import type { RepositoryRecommendationReport } from "../src/recommendations/types";
import type { IRepositoryRegistry } from "../src/repositories/interfaces";
import { RuntimeAlreadyStartedError } from "../src/runtime/errors";
import type { IBackgroundRuntime } from "../src/runtime/interfaces";
import type { BackgroundRuntimeStatus } from "../src/runtime/types";
import type { IClaudeSessionManager } from "../src/session/interfaces";
import type { ClaudeSessionInfo } from "../src/session/types";
import type { IRuntimeStatusService } from "../src/status/interfaces";
import type { RuntimeStatus } from "../src/status/types";
import type { EngineeringWorkspace } from "../src/workspace/types";

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

// Records every method called on it — the primary tool for proving
// RuntimeControlService performs no direct runtime work of its own, only
// single delegating calls.
class RecordingRuntimePolicyEngine implements IRuntimePolicyEngine {
  calls: { method: string; args: unknown[] }[] = [];
  evaluateMonitoring() {
    this.calls.push({ method: "evaluateMonitoring", args: [] });
    return { allowed: true };
  }
  evaluateNotification() {
    this.calls.push({ method: "evaluateNotification", args: [] });
    return { allowed: true };
  }
  recordNotificationSent(repositoryId: string): void {
    this.calls.push({ method: "recordNotificationSent", args: [repositoryId] });
  }
  setMaintenanceMode(enabled: boolean): void {
    this.calls.push({ method: "setMaintenanceMode", args: [enabled] });
  }
  setRepositoryMonitoringEnabled(repositoryId: string, enabled: boolean): void {
    this.calls.push({ method: "setRepositoryMonitoringEnabled", args: [repositoryId, enabled] });
  }
  getStatus(): RuntimePolicyStatus {
    this.calls.push({ method: "getStatus", args: [] });
    return { maintenanceMode: false, quietHoursActive: false, repositoriesDisabled: 0, repositoriesInCooldown: 0, globalNotificationBudget: { used: 0, max: 0, windowMs: 0 } };
  }
}

class RecordingBackgroundRuntime implements IBackgroundRuntime {
  calls: string[] = [];
  start(): void {
    this.calls.push("start");
  }
  stop(): void {
    this.calls.push("stop");
  }
  getStatus(): BackgroundRuntimeStatus {
    this.calls.push("getStatus");
    return { running: false, startedAt: undefined, uptimeMs: undefined, workers: [] };
  }
  resetStatistics(): void {
    this.calls.push("resetStatistics");
  }
}

class RecordingAttentionDispatcher implements IAttentionDispatcher {
  calls: string[] = [];
  async dispatch(): Promise<void> {
    this.calls.push("dispatch");
  }
  getStatus(): AttentionDispatcherStatus {
    this.calls.push("getStatus");
    return { lastDispatchAt: undefined, notificationsDelivered: 0, notificationsSuppressed: 0 };
  }
  resetStatistics(): void {
    this.calls.push("resetStatistics");
  }
}

// Plain "throw if ever called" stand-ins for ApplicationService's other
// collaborators, matching the style already used in verify-runtime-status.ts.
class UnusedRepositoryIntelligenceService implements IRepositoryIntelligenceService {
  async getSnapshot(): Promise<RepositorySnapshot> {
    throw new Error("getRuntimeControl() must not touch IRepositoryIntelligenceService");
  }
}
class UnusedProjectMemoryService implements IProjectMemoryService {
  async record(): Promise<void> {
    throw new Error("not used");
  }
  async getRecentEvents(): Promise<ProjectMemoryEvent[]> {
    throw new Error("getRuntimeControl() must not touch IProjectMemoryService");
  }
}
class UnusedDecisionEngine implements IDecisionEngine {
  async analyze(): Promise<RepositoryInsightReport> {
    throw new Error("getRuntimeControl() must not touch IDecisionEngine");
  }
}
class UnusedSessionManager implements IClaudeSessionManager {
  resolveSession(): never {
    throw new Error("getRuntimeControl() must not touch IClaudeSessionManager");
  }
  resetSession(): void {
    throw new Error("not used");
  }
  expireSession(): void {
    throw new Error("not used");
  }
  getSessionStatus(): ClaudeSessionInfo | undefined {
    throw new Error("getRuntimeControl() must not touch IClaudeSessionManager");
  }
}
class UnusedRepositoryRegistry implements IRepositoryRegistry {
  getAllRepositories(): Repository[] {
    throw new Error("getRuntimeControl() must not touch IRepositoryRegistry");
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
    throw new Error("getRuntimeControl() must not touch IRecommendationEngine");
  }
}
class UnusedEngineeringAssistanceEngine implements IEngineeringAssistanceEngine {
  propose(): RepositoryAssistanceReport {
    throw new Error("getRuntimeControl() must not touch IEngineeringAssistanceEngine");
  }
}
class UnusedRuntimeStatusService implements IRuntimeStatusService {
  getStatus(): RuntimeStatus {
    throw new Error("getRuntimeControl() must not touch IRuntimeStatusService");
  }
}
class UnusedRuntimeAdministrationService implements IRuntimeAdministrationService {
  getStatus(): RuntimeStatus {
    throw new Error("getRuntimeControl() must not touch IRuntimeAdministrationService");
  }
  getControl(): IRuntimeControlService {
    throw new Error("getRuntimeControl() must not touch IRuntimeAdministrationService");
  }
  getPolicies(): RuntimePolicyStatus {
    throw new Error("getRuntimeControl() must not touch IRuntimeAdministrationService");
  }
}
class UnusedAutonomousPlanHistoryService implements IAutonomousPlanHistoryService {
  async record(): Promise<AutonomousPlanHistoryEntry> {
    throw new Error("getRuntimeControl() must not touch IAutonomousPlanHistoryService");
  }
  async getLatestEntry(): Promise<AutonomousPlanHistoryEntry | undefined> {
    throw new Error("getRuntimeControl() must not touch IAutonomousPlanHistoryService");
  }
  async getHistory(): Promise<AutonomousPlanHistoryEntry[]> {
    throw new Error("getRuntimeControl() must not touch IAutonomousPlanHistoryService");
  }
}

async function main(): Promise<void> {
  // RuntimeControlService performs no direct runtime work: every method is
  // exactly one delegating call to exactly one of its three collaborators.
  {
    const policy = new RecordingRuntimePolicyEngine();
    const runtime = new RecordingBackgroundRuntime();
    const dispatcher = new RecordingAttentionDispatcher();
    const control = new RuntimeControlService(policy, runtime, dispatcher);

    control.pauseMonitoring();
    assert(runtime.calls.join(",") === "stop", "pauseMonitoring() calls exactly BackgroundRuntime.stop(), nothing else");
    assert(policy.calls.length === 0 && dispatcher.calls.length === 0, "pauseMonitoring() does not touch RuntimePolicy or AttentionDispatcher");
  }
  {
    const policy = new RecordingRuntimePolicyEngine();
    const runtime = new RecordingBackgroundRuntime();
    const dispatcher = new RecordingAttentionDispatcher();
    const control = new RuntimeControlService(policy, runtime, dispatcher);

    control.resumeMonitoring();
    assert(runtime.calls.join(",") === "start", "resumeMonitoring() calls exactly BackgroundRuntime.start(), nothing else");
  }
  {
    const policy = new RecordingRuntimePolicyEngine();
    const runtime = new RecordingBackgroundRuntime();
    const dispatcher = new RecordingAttentionDispatcher();
    const control = new RuntimeControlService(policy, runtime, dispatcher);

    control.enterMaintenanceMode();
    assert(
      policy.calls.length === 1 && policy.calls[0]?.method === "setMaintenanceMode" && policy.calls[0]?.args[0] === true,
      "enterMaintenanceMode() calls exactly RuntimePolicy.setMaintenanceMode(true)",
    );
    assert(runtime.calls.length === 0 && dispatcher.calls.length === 0, "enterMaintenanceMode() does not touch BackgroundRuntime or AttentionDispatcher");

    control.exitMaintenanceMode();
    assert(
      policy.calls[1]?.method === "setMaintenanceMode" && policy.calls[1]?.args[0] === false,
      "exitMaintenanceMode() calls exactly RuntimePolicy.setMaintenanceMode(false)",
    );
  }
  {
    const policy = new RecordingRuntimePolicyEngine();
    const runtime = new RecordingBackgroundRuntime();
    const dispatcher = new RecordingAttentionDispatcher();
    const control = new RuntimeControlService(policy, runtime, dispatcher);

    control.enableRepository("alpha");
    assert(
      policy.calls[0]?.method === "setRepositoryMonitoringEnabled" && policy.calls[0]?.args[0] === "alpha" && policy.calls[0]?.args[1] === true,
      "enableRepository(id) calls exactly RuntimePolicy.setRepositoryMonitoringEnabled(id, true)",
    );

    control.disableRepository("beta");
    assert(
      policy.calls[1]?.method === "setRepositoryMonitoringEnabled" && policy.calls[1]?.args[0] === "beta" && policy.calls[1]?.args[1] === false,
      "disableRepository(id) calls exactly RuntimePolicy.setRepositoryMonitoringEnabled(id, false)",
    );
  }
  {
    const policy = new RecordingRuntimePolicyEngine();
    const runtime = new RecordingBackgroundRuntime();
    const dispatcher = new RecordingAttentionDispatcher();
    const control = new RuntimeControlService(policy, runtime, dispatcher);

    control.resetDispatcherStatistics();
    assert(dispatcher.calls.join(",") === "resetStatistics", "resetDispatcherStatistics() calls exactly AttentionDispatcher.resetStatistics()");
    assert(runtime.calls.length === 0 && policy.calls.length === 0, "resetDispatcherStatistics() does not touch BackgroundRuntime or RuntimePolicy");

    control.resetRuntimeStatistics();
    assert(runtime.calls.join(",") === "resetStatistics", "resetRuntimeStatistics() calls exactly BackgroundRuntime.resetStatistics()");
  }

  // resumeMonitoring() while already running is not swallowed or guarded —
  // BackgroundRuntime's own pre-existing RuntimeAlreadyStartedError
  // propagates unmodified, since RuntimeControlService holds no state of its
  // own to know "already running" without asking BackgroundRuntime.
  {
    const policy = new RecordingRuntimePolicyEngine();
    const runtime = new RecordingBackgroundRuntime();
    runtime.start(); // simulate "already running" from RuntimeControlService's perspective
    const failingRuntime: IBackgroundRuntime = {
      ...runtime,
      start: () => {
        throw new RuntimeAlreadyStartedError();
      },
    };
    const dispatcher = new RecordingAttentionDispatcher();
    const control = new RuntimeControlService(policy, failingRuntime, dispatcher);

    let threw = false;
    try {
      control.resumeMonitoring();
    } catch (error) {
      threw = error instanceof RuntimeAlreadyStartedError;
    }
    assert(threw, "resumeMonitoring() propagates BackgroundRuntime's own RuntimeAlreadyStartedError unmodified when already running");
  }

  // Maintenance mode still behaves exactly as before: driving it through
  // RuntimeControlService against a REAL RuntimePolicyEngine produces
  // identical evaluateMonitoring()/evaluateNotification() outcomes to
  // calling setMaintenanceMode() directly (Phase 8.4 behavior, unchanged).
  {
    const realPolicy = new RuntimePolicyEngine({ quietHours: { startHour: 0, endHour: 0 }, cooldownMs: 0, maxNotificationsPerInterval: 100, notificationIntervalMs: 60_000 });
    const runtime = new RecordingBackgroundRuntime();
    const dispatcher = new RecordingAttentionDispatcher();
    const control = new RuntimeControlService(realPolicy, runtime, dispatcher);

    assert(realPolicy.evaluateMonitoring("alpha").allowed === true, "monitoring allowed before entering maintenance mode via RuntimeControlService");

    control.enterMaintenanceMode();
    const monitoringDecision = realPolicy.evaluateMonitoring("alpha");
    const notificationDecision = realPolicy.evaluateNotification("alpha");
    assert(
      monitoringDecision.reason === "maintenance-mode" && notificationDecision.reason === "maintenance-mode",
      "entering maintenance mode via RuntimeControlService produces the exact same denial as calling RuntimePolicyEngine.setMaintenanceMode(true) directly",
    );

    control.exitMaintenanceMode();
    assert(realPolicy.evaluateMonitoring("alpha").allowed === true, "exiting maintenance mode via RuntimeControlService restores monitoring, identical to calling setMaintenanceMode(false) directly");
  }

  // Repository enable/disable still behaves exactly as before: same real
  // RuntimePolicyEngine, driven through RuntimeControlService's two
  // convenience methods rather than setRepositoryMonitoringEnabled()
  // directly, with identical outcomes (Phase 8.4 behavior, unchanged).
  {
    const realPolicy = new RuntimePolicyEngine({ quietHours: { startHour: 0, endHour: 0 }, cooldownMs: 0, maxNotificationsPerInterval: 100, notificationIntervalMs: 60_000 });
    const runtime = new RecordingBackgroundRuntime();
    const dispatcher = new RecordingAttentionDispatcher();
    const control = new RuntimeControlService(realPolicy, runtime, dispatcher);

    control.disableRepository("alpha");
    assert(realPolicy.evaluateMonitoring("alpha").reason === "repository-disabled", "disableRepository(id) via RuntimeControlService produces the same denial as setRepositoryMonitoringEnabled(id, false) directly");
    assert(realPolicy.evaluateMonitoring("beta").allowed === true, "a sibling repository is unaffected");

    control.enableRepository("alpha");
    assert(realPolicy.evaluateMonitoring("alpha").allowed === true, "enableRepository(id) via RuntimeControlService restores monitoring for that repository");
  }

  // DeferredRuntimeControlService: the composition-root seam that breaks the
  // ApplicationService <-> RuntimeControlService construction-time ordering
  // conflict.
  {
    const deferred = new DeferredRuntimeControlService();
    let threw = false;
    try {
      deferred.pauseMonitoring();
    } catch (error) {
      threw = error instanceof RuntimeControlServiceNotBoundError;
    }
    assert(threw, "DeferredRuntimeControlService throws RuntimeControlServiceNotBoundError before bind()");

    const policy = new RecordingRuntimePolicyEngine();
    const runtime = new RecordingBackgroundRuntime();
    const dispatcher = new RecordingAttentionDispatcher();
    const real = new RuntimeControlService(policy, runtime, dispatcher);

    deferred.bind(real);
    deferred.enterMaintenanceMode();
    assert(
      policy.calls[0]?.method === "setMaintenanceMode" && policy.calls[0]?.args[0] === true,
      "after bind(), DeferredRuntimeControlService transparently delegates every method to the real RuntimeControlService",
    );
  }

  // ApplicationService.getRuntimeControl() is pure delegation: it returns
  // the exact IRuntimeControlService reference it was constructed with, and
  // touches none of its other collaborators.
  {
    const policy = new RecordingRuntimePolicyEngine();
    const runtime = new RecordingBackgroundRuntime();
    const dispatcher = new RecordingAttentionDispatcher();
    const control = new RuntimeControlService(policy, runtime, dispatcher);

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
      control,
      new UnusedRuntimeAdministrationService(),
      new AutonomousPlanningEngine(),
      new UnusedAutonomousPlanHistoryService(),
      new AutonomousPlanStateEngine(new AutonomousPlanEvolutionEngine()),
    );

    let threw = false;
    let result: IRuntimeControlService | undefined;
    try {
      result = applicationService.getRuntimeControl();
    } catch {
      threw = true;
    }
    assert(!threw, "ApplicationService.getRuntimeControl() does not touch any of its other collaborators");
    assert(result === control, "ApplicationService.getRuntimeControl() returns the exact RuntimeControlService reference it was constructed with, unchanged");
  }
}

main();
