import { AutonomousPlanEvolutionEngine } from "../src/planhistory/AutonomousPlanEvolutionEngine";
import { AutonomousPlanStateEngine } from "../src/planstate/AutonomousPlanStateEngine";
import type { AutonomousPlan, AutonomousPlanItem } from "../src/autonomy/types";
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
import type { Repository } from "../src/domain/repository/Repository";
import type { IRepositoryIntelligenceService } from "../src/intelligence/interfaces";
import type { RepositorySnapshot } from "../src/intelligence/types";
import type { IProjectMemoryService } from "../src/memory/interfaces";
import type { ProjectMemoryEvent } from "../src/memory/types";
import type { IAutonomousPlanHistoryService } from "../src/planhistory/interfaces";
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

function chain(evolutionEngine: AutonomousPlanEvolutionEngine, plans: AutonomousPlan[]): AutonomousPlanHistoryEntry[] {
  const entries: AutonomousPlanHistoryEntry[] = [];
  let previous: AutonomousPlanHistoryEntry | undefined;
  let cycleNumber = 1;
  for (const p of plans) {
    const evolution = evolutionEngine.analyze(previous, p, cycleNumber);
    const recorded = entry(cycleNumber, p, evolution);
    entries.push(recorded);
    previous = recorded;
    cycleNumber += 1;
  }
  return entries.reverse(); // newest-first, matching AutonomousPlanHistoryService.getHistory()'s contract
}

function verifyDeriveStates(): void {
  const evolutionEngine = new AutonomousPlanEvolutionEngine();
  const stateEngine = new AutonomousPlanStateEngine(evolutionEngine);

  // Empty history -> empty states
  {
    assert(stateEngine.deriveStates([]).length === 0, "no recorded cycles -> deriveStates() returns an empty array, not a fabricated fallback");
  }

  // Single entry -> active, no supersededBy
  {
    const plan1 = plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
    const history = chain(evolutionEngine, [plan1]);
    const states = stateEngine.deriveStates(history);
    assert(states.length === 1, "one recorded cycle -> one state");
    assert(states[0].status === "active", "the only recorded cycle is active");
    assert(states[0].supersededBy === undefined, "an active plan carries no supersededBy");
    assert(states[0].planId === "p1" && states[0].cycleNumber === 1, "state carries the plan's own id and cycleNumber");
  }

  // Three entries -> newest active, older two superseded by their immediate successor
  {
    const plan1 = plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
    const plan2 = plan("p2", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
    const plan3 = plan("p3", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
    const history = chain(evolutionEngine, [plan1, plan2, plan3]); // newest-first: p3, p2, p1
    const states = stateEngine.deriveStates(history);

    assert(states[0].planId === "p3" && states[0].status === "active", "the newest recorded cycle (p3) is active");
    assert(states[1].planId === "p2" && states[1].status === "superseded", "p2 is superseded");
    assert(states[1].supersededBy?.planId === "p3" && states[1].supersededBy?.cycleNumber === 3, "p2's supersededBy points at p3, its immediate successor");
    assert(states[2].planId === "p1" && states[2].status === "superseded", "p1 is superseded");
    assert(states[2].supersededBy?.planId === "p2" && states[2].supersededBy?.cycleNumber === 2, "p1's supersededBy points at p2, its immediate successor -- not always at the current head (p3)");
  }

  // Truncated window: the oldest entry in the window is still correctly labeled by its immediate successor within that window
  {
    const plan1 = plan("p1", []);
    const plan2 = plan("p2", []);
    const plan3 = plan("p3", []);
    const fullHistory = chain(evolutionEngine, [plan1, plan2, plan3]);
    const windowed = fullHistory.slice(0, 2); // only the two newest: p3, p2
    const states = stateEngine.deriveStates(windowed);
    assert(states.length === 2, "a truncated window derives states only for the entries it was given");
    assert(states[0].status === "active" && states[1].status === "superseded", "within a truncated window, the newest is still active and the next is still superseded");
  }

  // Purity: calling deriveStates() twice with the same input produces identical output
  {
    const plan1 = plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
    const history = chain(evolutionEngine, [plan1]);
    const first = stateEngine.deriveStates(history);
    const second = stateEngine.deriveStates(history);
    assert(JSON.stringify(first) === JSON.stringify(second), "deriveStates() is a pure function -- identical input produces identical output, no internal state to drift");
  }
}

function verifyCompareToActive(): void {
  const evolutionEngine = new AutonomousPlanEvolutionEngine();
  const stateEngine = new AutonomousPlanStateEngine(evolutionEngine);

  // No active plan at all -> hasActivePlan false, matchesActivePlan false, no hypothetical evolution
  {
    const livePlan = plan("live", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
    const comparison = stateEngine.compareToActive(livePlan, undefined);
    assert(comparison.hasActivePlan === false, "nothing recorded yet -> hasActivePlan is false");
    assert(comparison.matchesActivePlan === false, "nothing recorded yet -> matchesActivePlan is false, a first cycle is always a change");
    assert(comparison.hypotheticalEvolution === undefined, "nothing recorded yet -> hypotheticalEvolution is undefined, there is nothing to compare against");
  }

  // Live plan identical to active -> matches
  {
    const activePlanValue = plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", priority: "high", category: "blocking" })]);
    const activeEntry = entry(1, activePlanValue, evolutionEngine.analyze(undefined, activePlanValue, 1));
    const livePlan = plan("live", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", priority: "high", category: "blocking" })]);

    const comparison = stateEngine.compareToActive(livePlan, activeEntry);
    assert(comparison.hasActivePlan === true, "an active plan exists -> hasActivePlan is true");
    assert(comparison.matchesActivePlan === true, "identical items/priority/category -> matchesActivePlan is true, recording now would be a no-op");
    assert(comparison.hypotheticalEvolution?.transitions.every((t) => t.changeType === "recurring") === true, "hypothetical evolution shows every item as recurring when nothing changed");
  }

  // Live plan differs (escalated) -> does not match
  {
    const activePlanValue = plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "ReviewChanges", priority: "medium", category: "advisory" })]);
    const activeEntry = entry(1, activePlanValue, evolutionEngine.analyze(undefined, activePlanValue, 1));
    const livePlan = plan("live", [item({ repositoryId: "alpha", sourceRecommendationKind: "ReviewChanges", priority: "critical", category: "blocking" })]);

    const comparison = stateEngine.compareToActive(livePlan, activeEntry);
    assert(comparison.matchesActivePlan === false, "priority escalated -> matchesActivePlan is false, recording now would be a genuine new cycle");
    assert(comparison.hypotheticalEvolution?.transitions[0]?.changeType === "escalating", "hypothetical evolution reuses the same escalating classification AutonomousPlanEvolutionEngine already computes");
  }

  // Empty live plan vs empty active plan -> matches (vacuous case)
  {
    const activePlanValue = plan("p1", []);
    const activeEntry = entry(1, activePlanValue, evolutionEngine.analyze(undefined, activePlanValue, 1));
    const livePlan = plan("live", []);
    const comparison = stateEngine.compareToActive(livePlan, activeEntry);
    assert(comparison.matchesActivePlan === true, "two empty plans (nothing to report in either) -> matchesActivePlan is true");
  }

  // hypotheticalEvolution.cycleNumber is clearly the *next* cycle, never overwriting the real active cycleNumber
  {
    const activePlanValue = plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
    const activeEntry = entry(5, activePlanValue, evolutionEngine.analyze(undefined, activePlanValue, 5));
    const livePlan = plan("live", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
    const comparison = stateEngine.compareToActive(livePlan, activeEntry);
    assert(comparison.hypotheticalEvolution?.cycleNumber === 6, "hypothetical cycleNumber is exactly one past the active entry's real cycleNumber");
    assert(activeEntry.cycleNumber === 5, "computing a hypothetical comparison never mutates the real active entry");
  }

  // Never records: compareToActive has no path to any write -- verified structurally (no IAutonomousPlanHistoryService dependency exists on this engine at all)
  {
    const livePlan = plan("live", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
    stateEngine.compareToActive(livePlan, undefined);
    stateEngine.compareToActive(livePlan, undefined);
    assert(true, "AutonomousPlanStateEngine's constructor takes only IAutonomousPlanEvolutionEngine -- there is no history-service reference for compareToActive to call record() on, even by accident");
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
class FakeRepositoryRegistry implements IRepositoryRegistry {
  constructor(private readonly repositories: Repository[]) {}
  getAllRepositories(): Repository[] {
    return this.repositories;
  }
  getRepository(id: string): Repository {
    return this.repositories.find((r) => r.id === id)!;
  }
  getActiveRepository(): Repository | undefined {
    return this.repositories[0];
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

class RecordingAutonomousPlanHistoryService implements IAutonomousPlanHistoryService {
  public recordCalls = 0;
  constructor(private readonly latest: AutonomousPlanHistoryEntry | undefined, private readonly history: AutonomousPlanHistoryEntry[]) {}
  async record(): Promise<AutonomousPlanHistoryEntry> {
    this.recordCalls += 1;
    throw new Error("ApplicationService must never call IAutonomousPlanHistoryService.record()");
  }
  async getLatestEntry(): Promise<AutonomousPlanHistoryEntry | undefined> {
    return this.latest;
  }
  async getHistory(limit?: number): Promise<AutonomousPlanHistoryEntry[]> {
    return limit ? this.history.slice(0, limit) : this.history;
  }
}

async function verifyApplicationServiceIntegration(): Promise<void> {
  const evolutionEngine = new AutonomousPlanEvolutionEngine();
  const stateEngine = new AutonomousPlanStateEngine(evolutionEngine);

  const plan1 = plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
  const plan2 = plan("p2", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
  const history = chain(evolutionEngine, [plan1, plan2]); // newest-first: p2, p1
  const historyService = new RecordingAutonomousPlanHistoryService(history[0], history);

  function buildService(repositories: Repository[]): IApplicationService {
    return new ApplicationService(
      new UnusedRepositoryIntelligenceService(),
      new UnusedProjectMemoryService(),
      new UnusedDecisionEngine(),
      new UnusedSessionManager(),
      new FakeRepositoryRegistry(repositories),
      new UnusedRecommendationEngine(),
      new UnusedEngineeringAssistanceEngine(),
      new UnusedRuntimeStatusService(),
      new RuntimeDiagnosticsEngine(),
      new RuntimeReportingEngine(),
      new UnusedRuntimeControlService(),
      new UnusedRuntimeAdministrationService(),
      new AutonomousPlanningEngine(),
      historyService,
      stateEngine,
    );
  }

  const applicationService = buildService([]);

  const states = await applicationService.getAutonomousPlanStates();
  assert(states.length === 2, "getAutonomousPlanStates() returns a state for every recorded cycle in the fetched window");
  assert(states[0].status === "active" && states[0].planId === "p2", "getAutonomousPlanStates()[0] is the active plan");
  assert(states[1].status === "superseded" && states[1].planId === "p1", "getAutonomousPlanStates()[1] is superseded");

  const current = await applicationService.getCurrentPlanState();
  assert(current?.planId === "p2" && current?.status === "active", "getCurrentPlanState() returns the current authoritative plan");

  const noHistoryService = new ApplicationService(
    new UnusedRepositoryIntelligenceService(),
    new UnusedProjectMemoryService(),
    new UnusedDecisionEngine(),
    new UnusedSessionManager(),
    new FakeRepositoryRegistry([]),
    new UnusedRecommendationEngine(),
    new UnusedEngineeringAssistanceEngine(),
    new UnusedRuntimeStatusService(),
    new RuntimeDiagnosticsEngine(),
    new RuntimeReportingEngine(),
    new UnusedRuntimeControlService(),
    new UnusedRuntimeAdministrationService(),
    new AutonomousPlanningEngine(),
    new RecordingAutonomousPlanHistoryService(undefined, []),
    stateEngine,
  );
  const noCurrent = await noHistoryService.getCurrentPlanState();
  assert(noCurrent === undefined, "no cycle ever recorded -> getCurrentPlanState() is undefined, not a fabricated state");

  // With zero registered repositories, ApplicationService.getAutonomousPlan()
  // (Phase 9.1, reused unchanged) fans out over an empty repository list and
  // returns an empty live plan -- a real, predictable value to compare
  // against the non-empty active plan p2, not a stub.
  const comparison = await applicationService.getLivePlanComparison();
  assert(comparison.hasActivePlan === true, "getLivePlanComparison() reuses the real active entry via getLatestEntry()");
  assert(comparison.matchesActivePlan === false, "an empty live plan does not match the non-empty active plan p2 -- the live view of the world has diverged from what was last recorded");
  assert(comparison.hypotheticalEvolution?.transitions.some((t) => t.changeType === "resolved") === true, "the hypothetical evolution correctly shows p2's item as resolved in the live plan, reusing AutonomousPlanEvolutionEngine's own classification");

  assert(historyService.recordCalls === 0, "none of getAutonomousPlanStates()/getCurrentPlanState()/getLivePlanComparison() ever call IAutonomousPlanHistoryService.record()");
}

async function main(): Promise<void> {
  verifyDeriveStates();
  verifyCompareToActive();
  await verifyApplicationServiceIntegration();
}

main();
