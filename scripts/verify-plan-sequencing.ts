import { AutonomousPlanEvolutionEngine } from "../src/planhistory/AutonomousPlanEvolutionEngine";
import { AutonomousPlanningAnalysisEngine } from "../src/plananalysis/AutonomousPlanningAnalysisEngine";
import { AutonomousPlanningService } from "../src/plan/AutonomousPlanningService";
import { AutonomousPlanReadinessEngine } from "../src/planreadiness/AutonomousPlanReadinessEngine";
import { AutonomousPlanRecordingService } from "../src/planrecording/AutonomousPlanRecordingService";
import { AutonomousPlanSequencingEngine } from "../src/plansequencing/AutonomousPlanSequencingEngine";
import { AutonomousPlanSchedulingEngine } from "../src/scheduling/AutonomousPlanSchedulingEngine";
import { AutonomousPlanStateEngine } from "../src/planstate/AutonomousPlanStateEngine";
import { AutonomousPlanningEngine } from "../src/autonomy/AutonomousPlanningEngine";
import { ApplicationService } from "../src/application/ApplicationService";
import type { IApplicationService } from "../src/application/interfaces";
import type { AutonomousPlan, AutonomousPlanItem } from "../src/autonomy/types";
import type { AutonomousPlanHistoryEntry } from "../src/planhistory/types";
import type { IAutonomousPlanHistoryService } from "../src/planhistory/interfaces";
import type { AutonomousPlanItemReadiness, AutonomousPlanReadinessReport } from "../src/planreadiness/types";
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

function readinessItem(overrides: Partial<AutonomousPlanItemReadiness> & Pick<AutonomousPlanItemReadiness, "repositoryId" | "sourceRecommendationKind" | "level">): AutonomousPlanItemReadiness {
  return {
    confidence: "medium",
    observedIndicators: [],
    cycleCount: 0,
    score: 0,
    ...overrides,
  };
}

function readinessReport(items: AutonomousPlanItemReadiness[], currentness: AutonomousPlanReadinessReport["summary"]["currentness"] = "current"): AutonomousPlanReadinessReport {
  const levelBreakdown = { high: 0, medium: 0, low: 0 };
  for (const item of items) {
    levelBreakdown[item.level] += 1;
  }
  return {
    generatedAt: new Date(),
    summary: { itemsAssessed: items.length, currentness, confidenceBreakdown: { high: 0, medium: 0, low: 0 }, levelBreakdown, averageScore: 0 },
    items,
  };
}

function verifyAutonomousPlanSequencingEngine(): void {
  const engine = new AutonomousPlanSequencingEngine();

  // Empty readiness -> empty sequence
  {
    const report = engine.sequence(readinessReport([]));
    assert(report.entries.length === 0, "no readiness items -> empty entries, not a fabricated fallback");
    assert(report.summary.entriesSequenced === 0, "no readiness items -> entriesSequenced is 0");
  }

  // Primary key: readiness level, low before medium before high
  {
    const items = [
      readinessItem({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", level: "high" }),
      readinessItem({ repositoryId: "beta", sourceRecommendationKind: "PullRequired", level: "low" }),
      readinessItem({ repositoryId: "gamma", sourceRecommendationKind: "PullRequired", level: "medium" }),
    ];
    const report = engine.sequence(readinessReport(items));
    assert(report.entries[0].repositoryId === "beta" && report.entries[0].level === "low", "low readiness level sorts first");
    assert(report.entries[1].repositoryId === "gamma" && report.entries[1].level === "medium", "medium readiness level sorts second");
    assert(report.entries[2].repositoryId === "alpha" && report.entries[2].level === "high", "high readiness level sorts last");
  }

  // Secondary key: cycleCount descending, within the same level
  {
    const items = [
      readinessItem({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", level: "medium", cycleCount: 2 }),
      readinessItem({ repositoryId: "beta", sourceRecommendationKind: "PullRequired", level: "medium", cycleCount: 5 }),
    ];
    const report = engine.sequence(readinessReport(items));
    assert(report.entries[0].repositoryId === "beta" && report.entries[0].cycleCount === 5, "within the same level, the longer-observed concern (higher cycleCount) sorts first");
    assert(report.entries[1].repositoryId === "alpha" && report.entries[1].cycleCount === 2, "the shorter-observed concern sorts second");
  }

  // Tertiary key: repositoryId alphabetically, when level and cycleCount tie
  {
    const items = [
      readinessItem({ repositoryId: "zulu", sourceRecommendationKind: "PullRequired", level: "low", cycleCount: 1 }),
      readinessItem({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", level: "low", cycleCount: 1 }),
    ];
    const report = engine.sequence(readinessReport(items));
    assert(report.entries[0].repositoryId === "alpha" && report.entries[1].repositoryId === "zulu", "equal level and cycleCount -> repositoryId breaks the tie alphabetically");
  }

  // Quaternary key: sourceRecommendationKind alphabetically, when everything else ties
  {
    const items = [
      readinessItem({ repositoryId: "alpha", sourceRecommendationKind: "ReviewChanges", level: "low", cycleCount: 1 }),
      readinessItem({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", level: "low", cycleCount: 1 }),
    ];
    const report = engine.sequence(readinessReport(items));
    assert(
      report.entries[0].sourceRecommendationKind === "PullRequired" && report.entries[1].sourceRecommendationKind === "ReviewChanges",
      "equal level, cycleCount, and repositoryId -> sourceRecommendationKind breaks the tie alphabetically",
    );
  }

  // score is never consulted -- two items with identical level but wildly different (non-contractual) scores still order purely by level/cycleCount/identity
  {
    const items = [
      readinessItem({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", level: "medium", cycleCount: 1, score: 100 }),
      readinessItem({ repositoryId: "beta", sourceRecommendationKind: "PullRequired", level: "medium", cycleCount: 1, score: 0 }),
    ];
    const report = engine.sequence(readinessReport(items));
    assert(report.entries[0].repositoryId === "alpha" && report.entries[1].repositoryId === "beta", "score is never read by the comparator -- identical level/cycleCount ties break on repositoryId regardless of how different the scores are");
  }

  // Carried-forward fields: level and cycleCount, never recomputed
  {
    const items = [readinessItem({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", level: "high", cycleCount: 7 })];
    const report = engine.sequence(readinessReport(items));
    assert(report.entries[0].level === "high" && report.entries[0].cycleCount === 7, "level and cycleCount are carried forward from AutonomousPlanItemReadiness unchanged");
  }

  // Summary fields carried forward / recomputed honestly
  {
    const items = [
      readinessItem({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", level: "low" }),
      readinessItem({ repositoryId: "beta", sourceRecommendationKind: "PullRequired", level: "high" }),
    ];
    const report = engine.sequence(readinessReport(items, "diverged"));
    assert(report.summary.currentness === "diverged", "summary.currentness carries forward the readiness report's own plan-level fact unchanged");
    assert(report.summary.levelBreakdown.low === 1 && report.summary.levelBreakdown.high === 1, "summary.levelBreakdown mirrors the readiness report's own breakdown");
    assert(report.summary.entriesSequenced === 2, "entriesSequenced matches the number of items sequenced");
  }

  // No sequence/index field on entries -- array position is the order
  {
    const items = [
      readinessItem({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", level: "low" }),
      readinessItem({ repositoryId: "beta", sourceRecommendationKind: "PullRequired", level: "high" }),
    ];
    const report = engine.sequence(readinessReport(items));
    const keys = Object.keys(report.entries[0]);
    assert(!keys.includes("sequence") && !keys.includes("index") && !keys.includes("position"), "entries carry no redundant sequence/index/position field -- array order alone is the descriptive order");
  }

  // No timing, cadence, interval, scheduling, approval, eligibility, or execution vocabulary anywhere in the output shape
  {
    const items = [readinessItem({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", level: "medium" })];
    const report = engine.sequence(readinessReport(items));
    const forbiddenKeys = ["interval", "cadence", "schedule", "scheduledAt", "nextRun", "dueAt", "approved", "eligible", "requiresReview", "execute"];
    const allKeys = [...Object.keys(report), ...Object.keys(report.summary), ...Object.keys(report.entries[0])];
    assert(!forbiddenKeys.some((forbidden) => allKeys.includes(forbidden)), "no timing/cadence/scheduling/approval/eligibility/execution field exists anywhere in the report shape");
  }

  // Purity: calling sequence() twice with the same input produces identical output
  {
    const items = [
      readinessItem({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", level: "medium", cycleCount: 3 }),
      readinessItem({ repositoryId: "beta", sourceRecommendationKind: "PullRequired", level: "low", cycleCount: 1 }),
    ];
    const input = readinessReport(items);
    const first = engine.sequence(input);
    const second = engine.sequence(input);
    assert(
      JSON.stringify({ ...first, generatedAt: undefined }) === JSON.stringify({ ...second, generatedAt: undefined }),
      "sequence() is a pure function -- identical input produces identical output, no internal state to drift",
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

async function verifyApplicationServiceIntegration(): Promise<void> {
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
  const sequencingEngine = new AutonomousPlanSequencingEngine();
  const schedulingEngine = new AutonomousPlanSchedulingEngine();
  const recordingService = new AutonomousPlanRecordingService(historyService);

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
    sequencingEngine,
    schedulingEngine,
    recordingService,
  );

  const sequenceReport = await applicationService.getAutonomousPlanSequence();

  assert(sequenceReport.entries.length === 1, "getAutonomousPlanSequence() sequences exactly the one item the live plan produced");
  assert(sequenceReport.entries[0].repositoryId === "alpha" && sequenceReport.entries[0].sourceRecommendationKind === "PullRequired", "the sequenced entry's identity matches the live plan's own item");
  assert(sequenceReport.entries[0].level === "high", "level is carried forward from the readiness assessment (blocking category -> high confidence -> no observed indicators -> high level)");
  assert(sequenceReport.summary.currentness === "current", "summary.currentness carries forward the readiness report's own currentness fact");

  assert(historyService.recordCalls === 0, "getAutonomousPlanSequence() never calls IAutonomousPlanHistoryService.record(), anywhere in the chain");

  // Cross-check: sequencing the same readiness report fetched independently
  // produces the same result -- proving getAutonomousPlanSequence() is
  // honestly composing readiness data, not something else.
  const independentReadiness = await applicationService.getAutonomousPlanReadiness();
  const independentSequence = sequencingEngine.sequence(independentReadiness);
  assert(
    JSON.stringify({ ...sequenceReport, generatedAt: undefined }) === JSON.stringify({ ...independentSequence, generatedAt: undefined }),
    "getAutonomousPlanSequence()'s result matches independently sequencing the same readiness report",
  );

  // Empty registry -> empty sequence
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
      sequencingEngine,
      schedulingEngine,
      new AutonomousPlanRecordingService(emptyHistoryService),
    );
    const emptySequence = await emptyApplicationService.getAutonomousPlanSequence();
    assert(emptySequence.entries.length === 0, "no registered repositories -> an empty live plan -> an empty sequence");
    assert(emptyHistoryService.recordCalls === 0, "getAutonomousPlanSequence() never calls record(), even against an empty history");
  }
}

async function main(): Promise<void> {
  verifyAutonomousPlanSequencingEngine();
  await verifyApplicationServiceIntegration();
}

main();
