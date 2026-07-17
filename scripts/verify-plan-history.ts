import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AutonomousPlanEvolutionEngine } from "../src/planhistory/AutonomousPlanEvolutionEngine";
import { AutonomousPlanHistoryService } from "../src/planhistory/AutonomousPlanHistoryService";
import type { AutonomousPlan, AutonomousPlanItem } from "../src/autonomy/types";
import type { IConfigService } from "../src/config/interfaces";
import type { ClaudeConfig, ControllerConfig, GithubConfig, TelegramConfig } from "../src/config/types";
import type { Repository } from "../src/domain/repository/Repository";
import type { AutonomousPlanHistoryEntry } from "../src/planhistory/types";
import { ApplicationService } from "../src/application/ApplicationService";
import type { IApplicationService } from "../src/application/interfaces";
import type { IRuntimeAdministrationService } from "../src/admin/interfaces";
import type { IEngineeringAssistanceEngine } from "../src/assistance/interfaces";
import type { RepositoryAssistanceReport } from "../src/assistance/types";
import { AutonomousPlanningEngine } from "../src/autonomy/AutonomousPlanningEngine";
import type { IRuntimeControlService } from "../src/control/interfaces";
import type { IDecisionEngine } from "../src/decisions/interfaces";
import type { RepositoryInsightReport } from "../src/decisions/types";
import { RuntimeDiagnosticsEngine } from "../src/diagnostics/RuntimeDiagnosticsEngine";
import type { IRepositoryIntelligenceService } from "../src/intelligence/interfaces";
import type { RepositorySnapshot } from "../src/intelligence/types";
import type { IProjectMemoryService } from "../src/memory/interfaces";
import type { ProjectMemoryEvent } from "../src/memory/types";
import type { IAutonomousPlanHistoryService } from "../src/planhistory/interfaces";
import { AutonomousPlanningService } from "../src/plan/AutonomousPlanningService";
import { AutonomousPlanStateEngine } from "../src/planstate/AutonomousPlanStateEngine";
import type { IRecommendationEngine } from "../src/recommendations/interfaces";
import type { RepositoryRecommendationReport } from "../src/recommendations/types";
import type { IRepositoryRegistry } from "../src/repositories/interfaces";
import { RuntimeReportingEngine } from "../src/reporting/RuntimeReportingEngine";
import type { IClaudeSessionManager } from "../src/session/interfaces";
import type { ClaudeSessionInfo } from "../src/session/types";
import type { IRuntimeStatusService } from "../src/status/interfaces";
import type { RuntimeStatus } from "../src/status/types";

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

function item(overrides: Partial<AutonomousPlanItem> & Pick<AutonomousPlanItem, "repositoryId" | "sourceRecommendationKind">): AutonomousPlanItem {
  return {
    category: "advisory",
    priority: "medium",
    reason: "test",
    supportingEvidence: [],
    confidence: "medium",
    ...overrides,
  };
}

function plan(id: string, items: AutonomousPlanItem[]): AutonomousPlan {
  return { id, generatedAt: new Date(), repositoriesConsidered: [...new Set(items.map((i) => i.repositoryId))], items };
}

function entry(cycleNumber: number, plan: AutonomousPlan, evolution: ReturnType<AutonomousPlanEvolutionEngine["analyze"]>): AutonomousPlanHistoryEntry {
  return { cycleNumber, recordedAt: new Date(), plan, evolution };
}

async function verifyEvolutionEngine(): Promise<void> {
  const engine = new AutonomousPlanEvolutionEngine();

  // First cycle ever: no previous entry -> everything is "new", cycleCount 1
  {
    const currentPlan = plan("p1", [
      item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" }),
      item({ repositoryId: "beta", sourceRecommendationKind: "ContinueSession" }),
    ]);
    const report = engine.analyze(undefined, currentPlan, 1);
    assert(report.previousPlanId === undefined, "first cycle -> previousPlanId is undefined, no fabricated prior state");
    assert(report.currentPlanId === "p1", "currentPlanId matches the plan passed in");
    assert(report.cycleNumber === 1, "cycleNumber is exactly what was passed in, not recomputed");
    assert(report.transitions.every((t) => t.changeType === "new" && t.cycleCount === 1), "every item on the first cycle is classified 'new' with cycleCount 1");
  }

  // Recurring: same key, same priority/category across two cycles -> "recurring", cycleCount incremented
  {
    const cycle1Plan = plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", priority: "high", category: "blocking" })]);
    const cycle1Evolution = engine.analyze(undefined, cycle1Plan, 1);
    const cycle1Entry = entry(1, cycle1Plan, cycle1Evolution);

    const cycle2Plan = plan("p2", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", priority: "high", category: "blocking" })]);
    const cycle2Evolution = engine.analyze(cycle1Entry, cycle2Plan, 2);

    assert(cycle2Evolution.previousPlanId === "p1", "second cycle's previousPlanId references the first cycle's plan id");
    const transition = cycle2Evolution.transitions[0];
    assert(transition.changeType === "recurring", "unchanged priority/category across cycles -> recurring, not escalating");
    assert(transition.cycleCount === 2, "cycleCount increments from the previous cycle's own cycleCount");
    assert(transition.previousPriority === undefined && transition.previousCategory === undefined, "recurring transitions do not carry previousPriority/previousCategory");
  }

  // Escalating: priority gets worse between cycles -> "escalating", with previousPriority/previousCategory set
  {
    const cycle1Plan = plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "ReviewChanges", priority: "medium", category: "advisory" })]);
    const cycle1Entry = entry(1, cycle1Plan, engine.analyze(undefined, cycle1Plan, 1));

    const cycle2Plan = plan("p2", [item({ repositoryId: "alpha", sourceRecommendationKind: "ReviewChanges", priority: "critical", category: "blocking" })]);
    const cycle2Evolution = engine.analyze(cycle1Entry, cycle2Plan, 2);

    const transition = cycle2Evolution.transitions[0];
    assert(transition.changeType === "escalating", "priority medium -> critical is classified escalating");
    assert(transition.previousPriority === "medium" && transition.previousCategory === "advisory", "escalating transitions carry the previous cycle's priority/category");
    assert(transition.priority === "critical" && transition.category === "blocking", "escalating transitions carry the current cycle's priority/category as priority/category");
    assert(transition.cycleCount === 2, "escalating still increments cycleCount, same as recurring");
  }

  // Category-only escalation (priority tied, category worsens) is also escalating
  {
    const cycle1Plan = plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "ReviewChanges", priority: "medium", category: "informational" })]);
    const cycle1Entry = entry(1, cycle1Plan, engine.analyze(undefined, cycle1Plan, 1));
    const cycle2Plan = plan("p2", [item({ repositoryId: "alpha", sourceRecommendationKind: "ReviewChanges", priority: "medium", category: "blocking" })]);
    const cycle2Evolution = engine.analyze(cycle1Entry, cycle2Plan, 2);
    assert(cycle2Evolution.transitions[0].changeType === "escalating", "equal priority, worsened category -> escalating (category is the tie-break, same ordering AutonomousPlanningEngine uses)");
  }

  // Improving priority (still present) is "recurring", not a fifth status
  {
    const cycle1Plan = plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "ReviewChanges", priority: "critical", category: "blocking" })]);
    const cycle1Entry = entry(1, cycle1Plan, engine.analyze(undefined, cycle1Plan, 1));
    const cycle2Plan = plan("p2", [item({ repositoryId: "alpha", sourceRecommendationKind: "ReviewChanges", priority: "low", category: "informational" })]);
    const cycle2Evolution = engine.analyze(cycle1Entry, cycle2Plan, 2);
    assert(cycle2Evolution.transitions[0].changeType === "recurring", "improved priority/category while still present -> recurring, not a separate 'improving' status");
  }

  // Resolved: present previously, absent now -> "resolved" exactly once, then drops out of tracking
  {
    const cycle1Plan = plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
    const cycle1Entry = entry(1, cycle1Plan, engine.analyze(undefined, cycle1Plan, 1));

    const cycle2Plan = plan("p2", []); // item disappeared
    const cycle2Evolution = engine.analyze(cycle1Entry, cycle2Plan, 2);
    assert(cycle2Evolution.transitions.length === 1 && cycle2Evolution.transitions[0].changeType === "resolved", "item absent this cycle after being present last cycle -> resolved");
    const cycle2Entry = entry(2, cycle2Plan, cycle2Evolution);

    const cycle3Plan = plan("p3", []); // still absent
    const cycle3Evolution = engine.analyze(cycle2Entry, cycle3Plan, 3);
    assert(cycle3Evolution.transitions.length === 0, "an already-resolved key is never re-flagged 'resolved' on a subsequent cycle just because it is still absent");
  }

  // Reappearance after resolution is "new" again, not a continuation of the old streak
  {
    const cycle1Plan = plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
    const cycle1Entry = entry(1, cycle1Plan, engine.analyze(undefined, cycle1Plan, 1));
    const cycle2Plan = plan("p2", []);
    const cycle2Entry = entry(2, cycle2Plan, engine.analyze(cycle1Entry, cycle2Plan, 2));
    const cycle3Plan = plan("p3", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
    const cycle3Evolution = engine.analyze(cycle2Entry, cycle3Plan, 3);
    assert(cycle3Evolution.transitions[0].changeType === "new" && cycle3Evolution.transitions[0].cycleCount === 1, "a concern that resolved and later reappears is classified 'new' with a fresh cycleCount, not a continued streak");
  }

  // Purity: calling analyze() repeatedly with the same inputs never mutates anything and is always safe to call as a read-only query
  {
    const cycle1Plan = plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
    const cycle1Entry = entry(1, cycle1Plan, engine.analyze(undefined, cycle1Plan, 1));
    const cycle2Plan = plan("p2", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
    const first = engine.analyze(cycle1Entry, cycle2Plan, 2);
    const second = engine.analyze(cycle1Entry, cycle2Plan, 2);
    assert(JSON.stringify(first) === JSON.stringify(second), "calling analyze() twice with identical inputs produces identical output — no internal state to drift");
  }

  // Different repositories with the same recommendation kind are tracked independently
  {
    const cycle1Plan = plan("p1", [
      item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" }),
      item({ repositoryId: "beta", sourceRecommendationKind: "PullRequired" }),
    ]);
    const cycle1Entry = entry(1, cycle1Plan, engine.analyze(undefined, cycle1Plan, 1));
    const cycle2Plan = plan("p2", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]); // beta's item disappeared
    const cycle2Evolution = engine.analyze(cycle1Entry, cycle2Plan, 2);
    const alphaTransition = cycle2Evolution.transitions.find((t) => t.repositoryId === "alpha")!;
    const betaTransition = cycle2Evolution.transitions.find((t) => t.repositoryId === "beta")!;
    assert(alphaTransition.changeType === "recurring", "alpha's identical concern persists -> recurring");
    assert(betaTransition.changeType === "resolved", "beta's concern disappeared independently of alpha's -> resolved");
  }
}

class FakeConfigService implements IConfigService {
  constructor(private readonly directory: string) {}
  getControllerConfig(): ControllerConfig {
    return {
      controller: { name: "test", version: "0.0.0", environment: "test" },
      workspace: { root: "/tmp" },
      task: { max_concurrent_jobs: 1, timeout_minutes: 1 },
      approval: { mode: "manual", require_before_git_push: true, require_before_pull_request: true },
      logging: { enabled: false, level: "info", directory: "/tmp" },
      memory: { enabled: true, directory: this.directory },
    };
  }
  getClaudeConfig(): ClaudeConfig {
    throw new Error("not used");
  }
  getGithubConfig(): GithubConfig {
    throw new Error("not used");
  }
  getTelegramConfig(): TelegramConfig {
    throw new Error("not used");
  }
  getRepositories(): Repository[] {
    throw new Error("not used");
  }
  reload(): void {
    throw new Error("not used");
  }
}

async function verifyHistoryService(): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "plan-history-verify-"));
  try {
    const configService = new FakeConfigService(directory);
    const evolutionEngine = new AutonomousPlanEvolutionEngine();
    const service = new AutonomousPlanHistoryService(configService, evolutionEngine);

    assert((await service.getLatestEntry()) === undefined, "no cycle recorded yet -> getLatestEntry() is undefined");
    assert((await service.getHistory()).length === 0, "no cycle recorded yet -> getHistory() is an empty array, not a fabricated fallback");

    const plan1 = plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", priority: "high", category: "blocking" })]);
    const recorded1 = await service.record(plan1);
    assert(recorded1.cycleNumber === 1, "the first ever recorded cycle is assigned cycleNumber 1");
    assert(recorded1.evolution.transitions[0].changeType === "new", "the first recorded cycle's own evolution classifies its items as new");

    const plan2 = plan("p2", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", priority: "high", category: "blocking" })]);
    const recorded2 = await service.record(plan2);
    assert(recorded2.cycleNumber === 2, "cycleNumber increments monotonically across recorded cycles");
    assert(recorded2.evolution.previousPlanId === "p1", "the second recorded cycle's evolution references the first plan's id");
    assert(recorded2.evolution.transitions[0].changeType === "recurring", "recording computes evolution against the truly previous cycle, not itself");

    const latest = await service.getLatestEntry();
    assert(latest?.cycleNumber === 2, "getLatestEntry() returns the most recently recorded cycle");
    assert(latest?.plan.id === "p2", "getLatestEntry() carries the exact plan that was recorded");

    const history = await service.getHistory();
    assert(history.length === 2, "getHistory() returns every recorded cycle");
    assert(history[0].cycleNumber === 2 && history[1].cycleNumber === 1, "getHistory() reads newest-first");

    const limited = await service.getHistory(1);
    assert(limited.length === 1 && limited[0].cycleNumber === 2, "getHistory(limit) respects the limit and still returns the newest entries first");

    assert(recorded1.recordedAt instanceof Date, "recordedAt round-trips as a real Date, not a string, after persistence");
    const rehydratedFromDisk = await service.getHistory();
    assert(rehydratedFromDisk[0].recordedAt instanceof Date, "Dates round-trip correctly when read back from the on-disk JSONL file");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

class ThrowingAutonomousPlanHistoryService implements IAutonomousPlanHistoryService {
  public recordCalls = 0;
  public getHistoryCalls = 0;
  public getLatestEntryCalls = 0;
  constructor(private readonly latest: AutonomousPlanHistoryEntry | undefined, private readonly history: AutonomousPlanHistoryEntry[]) {}
  async record(): Promise<AutonomousPlanHistoryEntry> {
    this.recordCalls += 1;
    throw new Error("ApplicationService must never call IAutonomousPlanHistoryService.record()");
  }
  async getLatestEntry(): Promise<AutonomousPlanHistoryEntry | undefined> {
    this.getLatestEntryCalls += 1;
    return this.latest;
  }
  async getHistory(limit?: number): Promise<AutonomousPlanHistoryEntry[]> {
    this.getHistoryCalls += 1;
    return limit ? this.history.slice(0, limit) : this.history;
  }
}

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
class UnusedRuntimeStatusService implements IRuntimeStatusService {
  getStatus(): RuntimeStatus {
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

async function verifyApplicationServiceIsReadOnly(): Promise<void> {
  const plan1 = plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
  const evolution1 = new AutonomousPlanEvolutionEngine().analyze(undefined, plan1, 1);
  const historyEntry: AutonomousPlanHistoryEntry = entry(1, plan1, evolution1);
  const fakeHistoryService = new ThrowingAutonomousPlanHistoryService(historyEntry, [historyEntry]);
  // Phase 9.4: ApplicationService no longer holds fakeHistoryService directly —
  // it goes through AutonomousPlanningService, the same façade production
  // code uses. record() staying unreachable is now a property of the whole
  // chain (ApplicationService -> AutonomousPlanningService -> the injected
  // IAutonomousPlanHistoryService), not just of ApplicationService alone.
  const autonomousPlanningService = new AutonomousPlanningService(
    fakeHistoryService,
    new AutonomousPlanStateEngine(new AutonomousPlanEvolutionEngine()),
  );

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
    new UnusedRuntimeAdministrationService(),
    new AutonomousPlanningEngine(),
    autonomousPlanningService,
  );

  const history = await applicationService.getAutonomousPlanHistory();
  assert(history.length === 1 && history[0] === historyEntry, "getAutonomousPlanHistory() still returns exactly what IAutonomousPlanHistoryService.getHistory() produces, now routed through AutonomousPlanningService.getRecentCycles()");
  assert(fakeHistoryService.getHistoryCalls === 1, "getAutonomousPlanHistory() calls getHistory() exactly once, no double-fetch");
  assert(fakeHistoryService.getLatestEntryCalls === 0, "getAutonomousPlanHistory() never touches getLatestEntry()");

  // getLatestAutonomousPlanEvolution() now goes through
  // AutonomousPlanningService.getRecentCycles(1) -- the same getHistory()
  // call getAutonomousPlanHistory() uses, not a dedicated getLatestEntry()
  // call, since the façade deliberately doesn't expose a one-for-one
  // "getLatestEvolution" method of its own (see IAutonomousPlanningService's
  // own doc comment).
  const evolution = await applicationService.getLatestAutonomousPlanEvolution();
  assert(evolution === historyEntry.evolution, "getLatestAutonomousPlanEvolution() returns exactly the evolution embedded in the latest recorded entry, never recomputed");
  assert(fakeHistoryService.getHistoryCalls === 2, "getLatestAutonomousPlanEvolution() calls getHistory(1) once more, cumulative with the call above");
  assert(fakeHistoryService.getLatestEntryCalls === 0, "getLatestAutonomousPlanEvolution() still never touches getLatestEntry() under the new implementation");

  assert(fakeHistoryService.recordCalls === 0, "ApplicationService never calls IAutonomousPlanHistoryService.record(), whether directly or via AutonomousPlanningService — recording is not either class's responsibility");

  const emptyHistoryService = new ThrowingAutonomousPlanHistoryService(undefined, []);
  const applicationService2: IApplicationService = new ApplicationService(
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
    new UnusedRuntimeAdministrationService(),
    new AutonomousPlanningEngine(),
    new AutonomousPlanningService(emptyHistoryService, new AutonomousPlanStateEngine(new AutonomousPlanEvolutionEngine())),
  );
  const noEvolution = await applicationService2.getLatestAutonomousPlanEvolution();
  assert(noEvolution === undefined, "no cycle ever recorded -> getLatestAutonomousPlanEvolution() is undefined, not a fabricated report");
  assert(emptyHistoryService.recordCalls === 0, "ApplicationService never calls record(), even when history is empty");
}

async function main(): Promise<void> {
  await verifyEvolutionEngine();
  await verifyHistoryService();
  await verifyApplicationServiceIsReadOnly();
}

main();
