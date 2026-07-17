import { AutonomousPlanEvolutionEngine } from "../src/planhistory/AutonomousPlanEvolutionEngine";
import { AutonomousPlanningAnalysisEngine } from "../src/plananalysis/AutonomousPlanningAnalysisEngine";
import { AutonomousPlanningService } from "../src/plan/AutonomousPlanningService";
import { AutonomousPlanReadinessEngine } from "../src/planreadiness/AutonomousPlanReadinessEngine";
import { AutonomousPlanStateEngine } from "../src/planstate/AutonomousPlanStateEngine";
import { AutonomousPlanningEngine } from "../src/autonomy/AutonomousPlanningEngine";
import { ApplicationService } from "../src/application/ApplicationService";
import type { IApplicationService } from "../src/application/interfaces";
import type { AutonomousPlan, AutonomousPlanItem } from "../src/autonomy/types";
import type { AutonomousPlanHistoryEntry } from "../src/planhistory/types";
import type { IAutonomousPlanHistoryService } from "../src/planhistory/interfaces";
import type { AutonomousPlanningSnapshot } from "../src/plan/types";
import type { AutonomousPlanAnalysisReport } from "../src/plananalysis/types";
import type { LivePlanComparison } from "../src/planstate/types";
import type { IRuntimeAdministrationService } from "../src/admin/interfaces";
import type { IEngineeringAssistanceEngine } from "../src/assistance/interfaces";
import type { RepositoryAssistanceReport } from "../src/assistance/types";
import type { IRuntimeControlService } from "../src/control/interfaces";
import type { IDecisionEngine } from "../src/decisions/interfaces";
import type { RepositoryInsightReport } from "../src/decisions/types";
import { RuntimeDiagnosticsEngine } from "../src/diagnostics/RuntimeDiagnosticsEngine";
import type { Repository } from "../src/domain/repository/Repository";
import type { IRepositoryIntelligenceService } from "../src/intelligence/interfaces";
import type { RepositorySnapshot } from "../src/intelligence/types";
import type { IProjectMemoryService } from "../src/memory/interfaces";
import type { ProjectMemoryEvent } from "../src/memory/types";
import type { IRecommendationEngine } from "../src/recommendations/interfaces";
import type { Recommendation, RepositoryRecommendationReport } from "../src/recommendations/types";
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

function historyEntry(cycleNumber: number, p: AutonomousPlan, evolution: ReturnType<AutonomousPlanEvolutionEngine["analyze"]>): AutonomousPlanHistoryEntry {
  return { cycleNumber, recordedAt: new Date(), plan: p, evolution };
}

function snapshot(p: AutonomousPlan, comparison: LivePlanComparison, currentState: AutonomousPlanningSnapshot["currentState"] = undefined): AutonomousPlanningSnapshot {
  return { generatedAt: new Date(), plan: p, currentState, comparison };
}

function analysisReport(items: AutonomousPlanAnalysisReport["items"]): AutonomousPlanAnalysisReport {
  return {
    generatedAt: new Date(),
    summary: {
      cyclesAnalyzed: 1,
      chronicCount: items.filter((i) => i.patterns.includes("chronic")).length,
      sustainedEscalationCount: items.filter((i) => i.patterns.includes("sustained-escalation")).length,
      flappingCount: items.filter((i) => i.patterns.includes("flapping")).length,
    },
    items,
  };
}

function noActiveComparison(): LivePlanComparison {
  return { hasActivePlan: false, matchesActivePlan: false, hypotheticalEvolution: undefined };
}

function verifyAutonomousPlanReadinessEngine(): void {
  const engine = new AutonomousPlanReadinessEngine();

  // Confidence alone, no observed indicators -> the three base scores/levels
  {
    const highItem = item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", confidence: "high" });
    const report = engine.assess(snapshot(plan("p1", [highItem]), noActiveComparison()), analysisReport([]));
    assert(report.items[0].score === 100 && report.items[0].level === "high", "high confidence, no indicators -> score 100, level high");
  }
  {
    const mediumItem = item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", confidence: "medium" });
    const report = engine.assess(snapshot(plan("p1", [mediumItem]), noActiveComparison()), analysisReport([]));
    assert(report.items[0].score === 60 && report.items[0].level === "medium", "medium confidence, no indicators -> score 60, level medium");
  }
  {
    const lowItem = item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", confidence: "low" });
    const report = engine.assess(snapshot(plan("p1", [lowItem]), noActiveComparison()), analysisReport([]));
    assert(report.items[0].score === 20 && report.items[0].level === "low", "low confidence, no indicators -> score 20, level low");
  }

  // Observed indicators deduct from the confidence base score
  {
    const highItem = item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", confidence: "high" });
    const analysis = analysisReport([
      { repositoryId: "alpha", sourceRecommendationKind: "PullRequired", patterns: ["flapping"], cycleCount: 3, consecutiveEscalations: 0, flapCount: 1 },
    ]);
    const report = engine.assess(snapshot(plan("p1", [highItem]), noActiveComparison()), analysis);
    const readiness = report.items[0];
    assert(readiness.score === 70, "high confidence (100) minus flapping (-30) -> score 70");
    assert(readiness.level === "high", "score 70 is exactly at the high threshold -> level high");
    assert(readiness.observedIndicators.length === 1 && readiness.observedIndicators[0] === "flapping", "observedIndicators carries the pattern forward verbatim from the analysis report");
    assert(readiness.cycleCount === 3, "cycleCount carries forward from the matching analysis entry");
  }
  {
    const highItem = item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", confidence: "high" });
    const analysis = analysisReport([
      { repositoryId: "alpha", sourceRecommendationKind: "PullRequired", patterns: ["flapping", "sustained-escalation"], cycleCount: 4, consecutiveEscalations: 2, flapCount: 1 },
    ]);
    const report = engine.assess(snapshot(plan("p1", [highItem]), noActiveComparison()), analysis);
    assert(report.items[0].score === 50, "100 - 30 (flapping) - 20 (sustained-escalation) = 50");
    assert(report.items[0].level === "medium", "score 50 -> level medium");
  }
  {
    const highItem = item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", confidence: "high" });
    const analysis = analysisReport([
      { repositoryId: "alpha", sourceRecommendationKind: "PullRequired", patterns: ["flapping", "sustained-escalation", "chronic"], cycleCount: 6, consecutiveEscalations: 2, flapCount: 1 },
    ]);
    const report = engine.assess(snapshot(plan("p1", [highItem]), noActiveComparison()), analysis);
    assert(report.items[0].score === 40, "100 - 30 - 20 - 10 = 40, exactly at the medium threshold");
    assert(report.items[0].level === "medium", "score 40 -> level medium (not low)");
  }
  {
    const lowItem = item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", confidence: "low" });
    const analysis = analysisReport([
      { repositoryId: "alpha", sourceRecommendationKind: "PullRequired", patterns: ["flapping"], cycleCount: 2, consecutiveEscalations: 0, flapCount: 1 },
    ]);
    const report = engine.assess(snapshot(plan("p1", [lowItem]), noActiveComparison()), analysis);
    assert(report.items[0].score === 0, "score is clamped at 0, never negative (low base 20 minus flapping's 30 deduction)");
    assert(report.items[0].level === "low", "score 0 -> level low");
  }

  // An item with no matching analysis entry -> empty indicators, cycleCount 0
  {
    const highItem = item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", confidence: "high" });
    const report = engine.assess(snapshot(plan("p1", [highItem]), noActiveComparison()), analysisReport([]));
    assert(report.items[0].observedIndicators.length === 0, "no matching analysis entry -> observedIndicators is empty, not fabricated");
    assert(report.items[0].cycleCount === 0, "no matching analysis entry -> cycleCount is 0");
  }

  // Empty plan -> empty items, zeroed summary
  {
    const report = engine.assess(snapshot(plan("p1", []), noActiveComparison()), analysisReport([]));
    assert(report.items.length === 0, "an empty live plan -> empty items");
    assert(report.summary.itemsAssessed === 0, "empty plan -> itemsAssessed is 0");
    assert(report.summary.averageScore === 0, "empty plan -> averageScore is 0, not NaN or a fabricated value");
    assert(
      report.summary.confidenceBreakdown.high === 0 && report.summary.confidenceBreakdown.medium === 0 && report.summary.confidenceBreakdown.low === 0,
      "empty plan -> every confidenceBreakdown count is 0",
    );
  }

  // Currentness: derived from LivePlanComparison, a plan-level fact, not per-item
  {
    const p = plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
    const current = engine.assess(snapshot(p, { hasActivePlan: true, matchesActivePlan: true, hypotheticalEvolution: undefined }), analysisReport([]));
    assert(current.summary.currentness === "current", "hasActivePlan true, matchesActivePlan true -> currentness 'current'");

    const diverged = engine.assess(snapshot(p, { hasActivePlan: true, matchesActivePlan: false, hypotheticalEvolution: undefined }), analysisReport([]));
    assert(diverged.summary.currentness === "diverged", "hasActivePlan true, matchesActivePlan false -> currentness 'diverged'");

    const unrecorded = engine.assess(snapshot(p, noActiveComparison()), analysisReport([]));
    assert(unrecorded.summary.currentness === "unrecorded", "hasActivePlan false -> currentness 'unrecorded'");
  }

  // Breakdown counts and average score across multiple items
  {
    const items = [
      item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", confidence: "high" }),
      item({ repositoryId: "beta", sourceRecommendationKind: "PullRequired", confidence: "medium" }),
      item({ repositoryId: "gamma", sourceRecommendationKind: "PullRequired", confidence: "low" }),
    ];
    const report = engine.assess(snapshot(plan("p1", items), noActiveComparison()), analysisReport([]));
    assert(report.summary.itemsAssessed === 3, "three items in the live plan -> itemsAssessed is 3");
    assert(
      report.summary.confidenceBreakdown.high === 1 && report.summary.confidenceBreakdown.medium === 1 && report.summary.confidenceBreakdown.low === 1,
      "confidenceBreakdown counts one item per confidence tier",
    );
    assert(
      report.summary.levelBreakdown.high === 1 && report.summary.levelBreakdown.medium === 1 && report.summary.levelBreakdown.low === 1,
      "levelBreakdown mirrors confidenceBreakdown when no indicators are observed (level is derived purely from the base score)",
    );
    assert(report.summary.averageScore === (100 + 60 + 20) / 3, "averageScore is the arithmetic mean of every item's score");
  }

  // Different repositories/kinds are assessed independently, matched by (repositoryId, sourceRecommendationKind)
  {
    const items = [
      item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", confidence: "high" }),
      item({ repositoryId: "alpha", sourceRecommendationKind: "ReviewChanges", confidence: "high" }),
    ];
    const analysis = analysisReport([
      { repositoryId: "alpha", sourceRecommendationKind: "PullRequired", patterns: ["chronic"], cycleCount: 5, consecutiveEscalations: 0, flapCount: 0 },
    ]);
    const report = engine.assess(snapshot(plan("p1", items), noActiveComparison()), analysis);
    const pullRequired = report.items.find((i) => i.sourceRecommendationKind === "PullRequired")!;
    const reviewChanges = report.items.find((i) => i.sourceRecommendationKind === "ReviewChanges")!;
    assert(pullRequired.observedIndicators.includes("chronic"), "PullRequired picks up its own matching analysis entry");
    assert(reviewChanges.observedIndicators.length === 0, "ReviewChanges, with no matching analysis entry, is unaffected by PullRequired's indicators");
  }

  // Purity: calling assess() twice with identical inputs produces identical output
  {
    const p = plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", confidence: "medium" })]);
    const input = snapshot(p, { hasActivePlan: true, matchesActivePlan: false, hypotheticalEvolution: undefined });
    const analysis = analysisReport([{ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", patterns: ["chronic"], cycleCount: 5, consecutiveEscalations: 0, flapCount: 0 }]);
    const first = engine.assess(input, analysis);
    const second = engine.assess(input, analysis);
    assert(
      JSON.stringify({ ...first, generatedAt: undefined }) === JSON.stringify({ ...second, generatedAt: undefined }),
      "assess() is a pure function -- identical input produces identical summary/items, no internal state to drift",
    );
  }
}

// ---- ApplicationService integration ----

function baseSnapshot(repositoryId: string): RepositorySnapshot {
  return {
    repository: { id: repositoryId, name: repositoryId, path: `/tmp/${repositoryId}`, defaultBranch: "main", active: true },
    branch: { current: "main", default: "main", ahead: 0, behind: 0 },
    workingTree: { isClean: true, staged: [], unstaged: [], untracked: [] },
    recentCommits: [],
    pullRequests: { open: [], openCount: 0 },
    health: { isGitRepository: true, isClean: true, hasUnpushedCommits: false, isBehindRemote: false, hasOpenPullRequests: false, issues: [] },
    workflowReadiness: { canShip: false, requiresApprovalBeforePush: false, requiresApprovalBeforePullRequest: false, blockers: [] },
    generatedAt: new Date(),
  };
}

class FakeRepositoryIntelligence implements IRepositoryIntelligenceService {
  async getSnapshot(repositoryId?: string): Promise<RepositorySnapshot> {
    return baseSnapshot(repositoryId ?? "alpha");
  }
}
class FakeDecisionEngine implements IDecisionEngine {
  async analyze(snapshotArg: RepositorySnapshot): Promise<RepositoryInsightReport> {
    return { repositoryId: snapshotArg.repository.id, generatedAt: new Date(), insights: [], notificationWorthyInsights: [] };
  }
}
class FakeRecommendationEngine implements IRecommendationEngine {
  recommend(snapshotArg: RepositorySnapshot): RepositoryRecommendationReport {
    const recommendation: Recommendation = { kind: "PullRequired", category: "blocking", priority: "high", reason: "test", supportingEvidence: [] };
    return { repositoryId: snapshotArg.repository.id, generatedAt: new Date(), recommendations: [recommendation] };
  }
}
class FakeSessionManager implements IClaudeSessionManager {
  resolveSession(): never {
    throw new Error("not used");
  }
  resetSession(): void {}
  expireSession(): void {}
  getSessionStatus(): ClaudeSessionInfo | undefined {
    return undefined;
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
class UnusedEngineeringAssistanceEngine implements IEngineeringAssistanceEngine {
  propose(): RepositoryAssistanceReport {
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
  constructor(private readonly history: AutonomousPlanHistoryEntry[]) {}
  async record(): Promise<AutonomousPlanHistoryEntry> {
    this.recordCalls += 1;
    throw new Error("must never call IAutonomousPlanHistoryService.record()");
  }
  async getLatestEntry(): Promise<AutonomousPlanHistoryEntry | undefined> {
    return this.history[0];
  }
  async getHistory(limit?: number): Promise<AutonomousPlanHistoryEntry[]> {
    return limit ? this.history.slice(0, limit) : this.history;
  }
}

async function verifyApplicationServiceIntegration(): Promise<void> {
  // A recorded history whose sole cycle exactly matches what the live plan
  // (built below from FakeRecommendationEngine's fixed recommendation) will
  // produce -- repositoryId "alpha", kind "PullRequired", category
  // "blocking", priority "high" -- so the live plan is expected to compare
  // as "current" against it.
  const evolutionEngine = new AutonomousPlanEvolutionEngine();
  const recordedPlan = plan("recorded-1", [
    item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", category: "blocking", priority: "high", confidence: "high" }),
  ]);
  const recordedEntry = historyEntry(1, recordedPlan, evolutionEngine.analyze(undefined, recordedPlan, 1));
  const historyService = new RecordingAutonomousPlanHistoryService([recordedEntry]);

  const stateEngine = new AutonomousPlanStateEngine(evolutionEngine);
  const analysisEngine = new AutonomousPlanningAnalysisEngine();
  const autonomousPlanningService = new AutonomousPlanningService(historyService, stateEngine, analysisEngine);
  const readinessEngine = new AutonomousPlanReadinessEngine();

  const applicationService: IApplicationService = new ApplicationService(
    new FakeRepositoryIntelligence(),
    new UnusedProjectMemoryService(),
    new FakeDecisionEngine(),
    new FakeSessionManager(),
    new FakeRepositoryRegistry([{ id: "alpha", name: "alpha", path: "/tmp/alpha", defaultBranch: "main", active: true }]),
    new FakeRecommendationEngine(),
    new UnusedEngineeringAssistanceEngine(),
    new UnusedRuntimeStatusService(),
    new RuntimeDiagnosticsEngine(),
    new RuntimeReportingEngine(),
    new UnusedRuntimeControlService(),
    new UnusedRuntimeAdministrationService(),
    new AutonomousPlanningEngine(),
    autonomousPlanningService,
    readinessEngine,
  );

  const report = await applicationService.getAutonomousPlanReadiness();

  assert(report.items.length === 1, "getAutonomousPlanReadiness() assesses exactly the one item the live plan produced");
  const readiness = report.items[0];
  assert(readiness.repositoryId === "alpha" && readiness.sourceRecommendationKind === "PullRequired", "the assessed item's identity matches the live plan's own item");
  // AutonomousPlanningEngine.confidenceFor() maps category "blocking" -> "high" (Phase 9.1)
  assert(readiness.confidence === "high", "confidence is carried forward from the live plan's own item, not recomputed here");
  assert(readiness.score === 100 && readiness.level === "high", "identical, unremarkable recurring history -> no observed indicators -> full confidence-based score");
  assert(report.summary.currentness === "current", "the live plan matches the sole recorded cycle exactly -> currentness 'current'");

  assert(historyService.recordCalls === 0, "getAutonomousPlanReadiness() never calls IAutonomousPlanHistoryService.record(), anywhere in the chain");

  // Cross-check: assessing the same snapshot+analysis directly, fetched
  // independently, produces the same result -- proving getAutonomousPlanReadiness()
  // is honestly composing the same Planning-domain data, not something else.
  const livePlan = await applicationService.getAutonomousPlan();
  const independentSnapshot = await autonomousPlanningService.getPlanningStatus(livePlan);
  const independentAnalysis = await autonomousPlanningService.getAnalysis();
  const independentReport = readinessEngine.assess(independentSnapshot, independentAnalysis);
  assert(
    JSON.stringify({ ...report, generatedAt: undefined }) === JSON.stringify({ ...independentReport, generatedAt: undefined }),
    "getAutonomousPlanReadiness()'s result matches independently assessing the same Planning-domain snapshot and analysis",
  );

  // No live plan diverging from an empty recorded history -> unrecorded
  {
    const emptyHistoryService = new RecordingAutonomousPlanHistoryService([]);
    const emptyPlanningService = new AutonomousPlanningService(emptyHistoryService, stateEngine, analysisEngine);
    const emptyApplicationService: IApplicationService = new ApplicationService(
      new FakeRepositoryIntelligence(),
      new UnusedProjectMemoryService(),
      new FakeDecisionEngine(),
      new FakeSessionManager(),
      new FakeRepositoryRegistry([]),
      new FakeRecommendationEngine(),
      new UnusedEngineeringAssistanceEngine(),
      new UnusedRuntimeStatusService(),
      new RuntimeDiagnosticsEngine(),
      new RuntimeReportingEngine(),
      new UnusedRuntimeControlService(),
      new UnusedRuntimeAdministrationService(),
      new AutonomousPlanningEngine(),
      emptyPlanningService,
      readinessEngine,
    );
    const emptyReport = await emptyApplicationService.getAutonomousPlanReadiness();
    assert(emptyReport.items.length === 0, "no registered repositories -> an empty live plan -> no items assessed");
    assert(emptyReport.summary.currentness === "unrecorded", "nothing has ever been recorded -> currentness 'unrecorded'");
    assert(emptyHistoryService.recordCalls === 0, "getAutonomousPlanReadiness() never calls record(), even against an empty history");
  }
}

async function main(): Promise<void> {
  verifyAutonomousPlanReadinessEngine();
  await verifyApplicationServiceIntegration();
}

main();
