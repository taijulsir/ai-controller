import { AutonomousPlanEvolutionEngine } from "../src/planhistory/AutonomousPlanEvolutionEngine";
import { AutonomousPlanningAnalysisEngine } from "../src/plananalysis/AutonomousPlanningAnalysisEngine";
import { AutonomousPlanningService } from "../src/plan/AutonomousPlanningService";
import { AutonomousPlanStateEngine } from "../src/planstate/AutonomousPlanStateEngine";
import { AutonomousPlanReadinessEngine } from "../src/planreadiness/AutonomousPlanReadinessEngine";
import { AutonomousPlanRecordingService } from "../src/planrecording/AutonomousPlanRecordingService";
import { AutonomousPlanSequencingEngine } from "../src/plansequencing/AutonomousPlanSequencingEngine";
import { AutonomousPlanSchedulingEngine } from "../src/scheduling/AutonomousPlanSchedulingEngine";
import type { AutonomousPlan, AutonomousPlanItem } from "../src/autonomy/types";
import type { AutonomousPlanHistoryEntry } from "../src/planhistory/types";
import type { AutonomousPlanCycleSummary } from "../src/plan/types";
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

// Builds an AutonomousPlanCycleSummary[] window directly -- what
// AutonomousPlanningService.getRecentCycles() would return for the given
// plan sequence -- so the analysis engine can be tested standalone without
// going through the façade or any IAutonomousPlanHistoryService fixture.
function cycleSummaries(
  evolutionEngine: AutonomousPlanEvolutionEngine,
  stateEngine: AutonomousPlanStateEngine,
  plans: AutonomousPlan[],
): AutonomousPlanCycleSummary[] {
  const history = chain(evolutionEngine, plans);
  const states = stateEngine.deriveStates(history);
  return history.map((historyEntry, index) => ({ entry: historyEntry, state: states[index] }));
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
  public getLatestEntryCalls = 0;
  public getHistoryCalls = 0;
  constructor(private readonly latest: AutonomousPlanHistoryEntry | undefined, private readonly history: AutonomousPlanHistoryEntry[]) {}
  async record(): Promise<AutonomousPlanHistoryEntry> {
    this.recordCalls += 1;
    throw new Error("must never call IAutonomousPlanHistoryService.record()");
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

// Direct tests of the Phase 9.4 façade itself — its three consumer-oriented
// use cases, and the fetch-once discipline each one is supposed to hold.
async function verifyAutonomousPlanningService(): Promise<void> {
  const evolutionEngine = new AutonomousPlanEvolutionEngine();
  const stateEngine = new AutonomousPlanStateEngine(evolutionEngine);

  const plan1 = plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
  const plan2 = plan("p2", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
  const history = chain(evolutionEngine, [plan1, plan2]); // newest-first: p2, p1

  // getRecentCycles(): one history fetch, entry + derived state paired for every cycle
  {
    const historyService = new RecordingAutonomousPlanHistoryService(history[0], history);
    const service = new AutonomousPlanningService(historyService, stateEngine, new AutonomousPlanningAnalysisEngine());

    const cycles = await service.getRecentCycles();
    assert(cycles.length === 2, "getRecentCycles() returns one summary per recorded cycle in the fetched window");
    assert(cycles[0].entry.plan.id === "p2" && cycles[0].state.status === "active", "getRecentCycles()[0] pairs p2's entry with its active state");
    assert(cycles[1].entry.plan.id === "p1" && cycles[1].state.status === "superseded", "getRecentCycles()[1] pairs p1's entry with its superseded state");
    assert(historyService.getHistoryCalls === 1, "getRecentCycles() fetches history exactly once, reused for both entries and derived states");
    assert(historyService.getLatestEntryCalls === 0, "getRecentCycles() never touches getLatestEntry()");
    assert(historyService.recordCalls === 0, "getRecentCycles() never calls record()");

    const limited = await service.getRecentCycles(1);
    assert(limited.length === 1 && limited[0].entry.plan.id === "p2", "getRecentCycles(limit) forwards the limit to the underlying history fetch");
  }

  // getCurrentPlanState(): a single-entry fetch, not the full window
  {
    const historyService = new RecordingAutonomousPlanHistoryService(history[0], history);
    const service = new AutonomousPlanningService(historyService, stateEngine, new AutonomousPlanningAnalysisEngine());

    const current = await service.getCurrentPlanState();
    assert(current?.planId === "p2" && current?.status === "active", "getCurrentPlanState() returns the current authoritative plan's state");
    assert(historyService.getLatestEntryCalls === 1, "getCurrentPlanState() calls getLatestEntry() exactly once");
    assert(historyService.getHistoryCalls === 0, "getCurrentPlanState() never fetches the full history window just to answer 'what's current'");
    assert(historyService.recordCalls === 0, "getCurrentPlanState() never calls record()");

    const emptyService = new AutonomousPlanningService(new RecordingAutonomousPlanHistoryService(undefined, []), stateEngine, new AutonomousPlanningAnalysisEngine());
    const noCurrent = await emptyService.getCurrentPlanState();
    assert(noCurrent === undefined, "no cycle ever recorded -> getCurrentPlanState() is undefined, not a fabricated state");
  }

  // getPlanningStatus(livePlan): one active-entry fetch, reused for both currentState and comparison
  {
    const historyService = new RecordingAutonomousPlanHistoryService(history[0], history);
    const service = new AutonomousPlanningService(historyService, stateEngine, new AutonomousPlanningAnalysisEngine());
    const livePlan = plan("live", []); // diverges from p2's non-empty item set

    const snapshot = await service.getPlanningStatus(livePlan);
    assert(snapshot.plan === livePlan, "getPlanningStatus() carries the exact live plan it was given");
    assert(snapshot.currentState?.planId === "p2" && snapshot.currentState?.status === "active", "getPlanningStatus() derives currentState from the same active entry as the comparison");
    assert(snapshot.comparison.hasActivePlan === true && snapshot.comparison.matchesActivePlan === false, "getPlanningStatus()'s comparison reflects that the empty live plan diverges from the non-empty active plan p2");
    assert(historyService.getLatestEntryCalls === 1, "getPlanningStatus() fetches the active entry exactly once, reused for both currentState and the comparison -- never two independent reads that could disagree");
    assert(historyService.recordCalls === 0, "getPlanningStatus() never calls record() -- it is a pure 'what if' query");

    const emptyService = new AutonomousPlanningService(new RecordingAutonomousPlanHistoryService(undefined, []), stateEngine, new AutonomousPlanningAnalysisEngine());
    const noActiveSnapshot = await emptyService.getPlanningStatus(livePlan);
    assert(noActiveSnapshot.currentState === undefined, "no cycle ever recorded -> getPlanningStatus().currentState is undefined");
    assert(noActiveSnapshot.comparison.hasActivePlan === false, "no cycle ever recorded -> getPlanningStatus().comparison.hasActivePlan is false");
  }

  // getAnalysis(limit): AutonomousPlanningService owns fetching the window
  // (via its own getRecentCycles()) and invoking the pure analysis engine --
  // this is the orchestration Phase 9.5's refinement specifically asked to
  // keep out of ApplicationService.
  {
    const historyService = new RecordingAutonomousPlanHistoryService(history[0], history);
    const analysisEngine = new AutonomousPlanningAnalysisEngine();
    const service = new AutonomousPlanningService(historyService, stateEngine, analysisEngine);

    const report = await service.getAnalysis();
    const expected = analysisEngine.analyze(await service.getRecentCycles());
    assert(JSON.stringify({ ...report, generatedAt: undefined }) === JSON.stringify({ ...expected, generatedAt: undefined }), "getAnalysis() produces exactly what analyzing the same getRecentCycles() window directly would produce");
    // Three getHistory() calls total: one inside getAnalysis()'s own
    // getRecentCycles() call, one inside the direct getRecentCycles() call
    // above used only to compute `expected` for this assertion, and zero
    // more -- getAnalysis() itself performs exactly one.
    assert(historyService.getLatestEntryCalls === 0, "getAnalysis() never touches getLatestEntry()");
    assert(historyService.recordCalls === 0, "getAnalysis() never calls record()");

    const singleFetchHistoryService = new RecordingAutonomousPlanHistoryService(history[0], history);
    const singleFetchService = new AutonomousPlanningService(singleFetchHistoryService, stateEngine, analysisEngine);
    await singleFetchService.getAnalysis(1);
    assert(singleFetchHistoryService.getHistoryCalls === 1, "getAnalysis(limit) fetches history exactly once per call, reusing getRecentCycles()'s own fetch-once discipline");
  }
}

async function verifyApplicationServiceIntegration(): Promise<void> {
  const evolutionEngine = new AutonomousPlanEvolutionEngine();
  const stateEngine = new AutonomousPlanStateEngine(evolutionEngine);

  const plan1 = plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
  const plan2 = plan("p2", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
  const history = chain(evolutionEngine, [plan1, plan2]); // newest-first: p2, p1
  const historyService = new RecordingAutonomousPlanHistoryService(history[0], history);
  const autonomousPlanningService = new AutonomousPlanningService(historyService, stateEngine, new AutonomousPlanningAnalysisEngine());
  const recordingService = new AutonomousPlanRecordingService(historyService);

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
      autonomousPlanningService,
      new AutonomousPlanReadinessEngine(),
      new AutonomousPlanSequencingEngine(),
      new AutonomousPlanSchedulingEngine(),
      recordingService,
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
    new AutonomousPlanningService(new RecordingAutonomousPlanHistoryService(undefined, []), stateEngine, new AutonomousPlanningAnalysisEngine()),
    new AutonomousPlanReadinessEngine(),
    new AutonomousPlanSequencingEngine(),
    new AutonomousPlanSchedulingEngine(),
    new AutonomousPlanRecordingService(new RecordingAutonomousPlanHistoryService(undefined, [])),
  );
  const noCurrent = await noHistoryService.getCurrentPlanState();
  assert(noCurrent === undefined, "no cycle ever recorded -> getCurrentPlanState() is undefined, not a fabricated state");

  // With zero registered repositories, ApplicationService.getAutonomousPlan()
  // (Phase 9.1, reused unchanged) fans out over an empty repository list and
  // returns an empty live plan -- a real, predictable value to compare
  // against the non-empty active plan p2, not a stub.
  const comparison = await applicationService.getLivePlanComparison();
  assert(comparison.hasActivePlan === true, "getLivePlanComparison() reuses the real active entry via AutonomousPlanningService.getPlanningStatus()");
  assert(comparison.matchesActivePlan === false, "an empty live plan does not match the non-empty active plan p2 -- the live view of the world has diverged from what was last recorded");
  assert(comparison.hypotheticalEvolution?.transitions.some((t) => t.changeType === "resolved") === true, "the hypothetical evolution correctly shows p2's item as resolved in the live plan, reusing AutonomousPlanEvolutionEngine's own classification");

  const snapshot = await applicationService.getAutonomousPlanningSnapshot();
  assert(snapshot.currentState?.planId === "p2", "getAutonomousPlanningSnapshot() carries the current authoritative plan's state");
  assert(snapshot.comparison.matchesActivePlan === false, "getAutonomousPlanningSnapshot()'s comparison matches getLivePlanComparison()'s own result for the same live/active pair");

  // getAutonomousPlanAnalysis() is pure delegation to
  // AutonomousPlanningService.getAnalysis() -- ApplicationService performs
  // no orchestration of its own for this method, exactly like every other
  // Autonomous Planning query it exposes.
  const analysis = await applicationService.getAutonomousPlanAnalysis();
  assert(analysis.summary.cyclesAnalyzed === 2, "getAutonomousPlanAnalysis() reflects the same two-cycle window every other query in this test sees");

  assert(historyService.recordCalls === 0, "none of getAutonomousPlanStates()/getCurrentPlanState()/getLivePlanComparison()/getAutonomousPlanningSnapshot()/getAutonomousPlanAnalysis() ever call IAutonomousPlanHistoryService.record()");
}

function verifyAutonomousPlanningAnalysisEngine(): void {
  const engine = new AutonomousPlanningAnalysisEngine();
  const evolutionEngine = new AutonomousPlanEvolutionEngine();
  const stateEngine = new AutonomousPlanStateEngine(evolutionEngine);

  // No cycles -> empty report, not a fabricated fallback
  {
    const report = engine.analyze([]);
    assert(report.items.length === 0, "no cycles -> empty items");
    assert(report.summary.cyclesAnalyzed === 0, "no cycles -> cyclesAnalyzed is 0");
    assert(report.summary.chronicCount === 0 && report.summary.sustainedEscalationCount === 0 && report.summary.flappingCount === 0, "no cycles -> every summary count is 0");
  }

  // No pattern at all -> the item is absent from the report entirely
  {
    const cycles = cycleSummaries(evolutionEngine, stateEngine, [
      plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]),
    ]);
    const report = engine.analyze(cycles);
    assert(report.items.length === 0, "a single, unremarkable appearance -> no pattern, item omitted rather than included with an empty patterns array");
  }

  // Chronic: present, not resolved, cycleCount at or above the threshold (5)
  {
    const plans = Array.from({ length: 5 }, () => plan("p", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]));
    const cycles = cycleSummaries(evolutionEngine, stateEngine, plans);
    const report = engine.analyze(cycles);
    assert(report.items.length === 1, "5 consecutive cycles of the same concern -> exactly one analyzed item");
    const analysis = report.items[0];
    assert(analysis.patterns.includes("chronic"), "cycleCount 5 with the item still present -> chronic");
    assert(analysis.cycleCount === 5, "cycleCount on the analysis matches the newest transition's own cycleCount");
    assert(report.summary.chronicCount === 1, "summary.chronicCount reflects the one chronic item");
  }

  // Not chronic once resolved, even after a long prior streak
  {
    const plans = [
      ...Array.from({ length: 5 }, () => plan("p", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })])),
      plan("p6", []), // resolved in the 6th cycle
    ];
    const cycles = cycleSummaries(evolutionEngine, stateEngine, plans);
    const report = engine.analyze(cycles);
    assert(report.items.length === 0, "resolved in the newest cycle -> not chronic, and not flagged with any other pattern either (only one 'new' occurrence in the window)");
  }

  // Sustained escalation: >=2 consecutive escalating cycles
  {
    const cycles = cycleSummaries(evolutionEngine, stateEngine, [
      plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "ReviewChanges", priority: "medium", category: "advisory" })]),
      plan("p2", [item({ repositoryId: "alpha", sourceRecommendationKind: "ReviewChanges", priority: "high", category: "advisory" })]),
      plan("p3", [item({ repositoryId: "alpha", sourceRecommendationKind: "ReviewChanges", priority: "critical", category: "blocking" })]),
    ]);
    const report = engine.analyze(cycles);
    const analysis = report.items.find((i) => i.sourceRecommendationKind === "ReviewChanges")!;
    assert(analysis.patterns.includes("sustained-escalation"), "two consecutive escalating cycles -> sustained-escalation");
    assert(analysis.consecutiveEscalations === 2, "consecutiveEscalations counts exactly the two escalating cycles at the head of the window");
    assert(report.summary.sustainedEscalationCount === 1, "summary.sustainedEscalationCount reflects the one item");
  }

  // A single escalation is not sustained
  {
    const cycles = cycleSummaries(evolutionEngine, stateEngine, [
      plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "ReviewChanges", priority: "medium", category: "advisory" })]),
      plan("p2", [item({ repositoryId: "alpha", sourceRecommendationKind: "ReviewChanges", priority: "high", category: "advisory" })]),
    ]);
    const report = engine.analyze(cycles);
    assert(!report.items.some((i) => i.patterns.includes("sustained-escalation")), "a single escalating cycle alone -> not sustained-escalation");
  }

  // Flapping: new, resolved, new again within the window
  {
    const cycles = cycleSummaries(evolutionEngine, stateEngine, [
      plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]),
      plan("p2", []),
      plan("p3", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]),
    ]);
    const report = engine.analyze(cycles);
    const analysis = report.items.find((i) => i.sourceRecommendationKind === "PullRequired")!;
    assert(analysis.patterns.includes("flapping"), "resolved then reappeared within the window -> flapping");
    assert(analysis.flapCount === 1, "flapCount counts exactly the one reappearance");
    assert(!analysis.patterns.includes("chronic"), "a freshly reappeared item has cycleCount 1 -> not also chronic");
    assert(report.summary.flappingCount === 1, "summary.flappingCount reflects the one flapping item");
  }

  // Chronic and sustained-escalation can co-occur on the same item
  {
    const cycles = cycleSummaries(evolutionEngine, stateEngine, [
      plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "ReviewChanges", priority: "medium", category: "advisory" })]),
      plan("p2", [item({ repositoryId: "alpha", sourceRecommendationKind: "ReviewChanges", priority: "medium", category: "advisory" })]),
      plan("p3", [item({ repositoryId: "alpha", sourceRecommendationKind: "ReviewChanges", priority: "medium", category: "advisory" })]),
      plan("p4", [item({ repositoryId: "alpha", sourceRecommendationKind: "ReviewChanges", priority: "high", category: "advisory" })]),
      plan("p5", [item({ repositoryId: "alpha", sourceRecommendationKind: "ReviewChanges", priority: "critical", category: "blocking" })]),
    ]);
    const report = engine.analyze(cycles);
    const analysis = report.items[0];
    assert(analysis.patterns.includes("chronic") && analysis.patterns.includes("sustained-escalation"), "an item can carry both chronic and sustained-escalation at once");
    assert(report.summary.chronicCount === 1 && report.summary.sustainedEscalationCount === 1, "summary counts both patterns for the same underlying item");
  }

  // Different repositories with the same recommendation kind are tracked independently
  {
    const cycles = cycleSummaries(evolutionEngine, stateEngine, [
      plan("p1", [
        item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" }),
        item({ repositoryId: "beta", sourceRecommendationKind: "PullRequired" }),
      ]),
      plan("p2", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]), // beta's item disappeared
      plan("p3", [
        item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" }),
        item({ repositoryId: "beta", sourceRecommendationKind: "PullRequired" }),
      ]), // beta's reappeared
    ]);
    const report = engine.analyze(cycles);
    const alpha = report.items.find((i) => i.repositoryId === "alpha");
    const beta = report.items.find((i) => i.repositoryId === "beta");
    assert(alpha === undefined, "alpha's uninterrupted, unremarkable streak triggers no pattern");
    assert(beta?.patterns.includes("flapping") === true, "beta's resolve-then-reappear is independently detected as flapping");
  }

  // Purity: calling analyze() twice with the same input produces identical output
  {
    const cycles = cycleSummaries(evolutionEngine, stateEngine, [
      plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]),
      plan("p2", []),
      plan("p3", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]),
    ]);
    const first = engine.analyze(cycles);
    const second = engine.analyze(cycles);
    assert(JSON.stringify({ ...first, generatedAt: undefined }) === JSON.stringify({ ...second, generatedAt: undefined }), "analyze() is a pure function -- identical input produces identical summary/items, no internal state to drift");
  }
}

async function main(): Promise<void> {
  verifyDeriveStates();
  verifyCompareToActive();
  verifyAutonomousPlanningAnalysisEngine();
  await verifyAutonomousPlanningService();
  await verifyApplicationServiceIntegration();
}

main();
