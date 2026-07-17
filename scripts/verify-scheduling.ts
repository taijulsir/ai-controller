import { AutonomousPlanEvolutionEngine } from "../src/planhistory/AutonomousPlanEvolutionEngine";
import { AutonomousPlanningAnalysisEngine } from "../src/plananalysis/AutonomousPlanningAnalysisEngine";
import { AutonomousPlanningService } from "../src/plan/AutonomousPlanningService";
import { AutonomousPlanReadinessEngine } from "../src/planreadiness/AutonomousPlanReadinessEngine";
import { AutonomousPlanSequencingEngine } from "../src/plansequencing/AutonomousPlanSequencingEngine";
import { AutonomousPlanSchedulingEngine } from "../src/scheduling/AutonomousPlanSchedulingEngine";
import { AutonomousPlanStateEngine } from "../src/planstate/AutonomousPlanStateEngine";
import { AutonomousPlanningEngine } from "../src/autonomy/AutonomousPlanningEngine";
import { ApplicationService } from "../src/application/ApplicationService";
import type { IApplicationService } from "../src/application/interfaces";
import type { AutonomousPlan, AutonomousPlanItem } from "../src/autonomy/types";
import type { AutonomousPlanHistoryEntry } from "../src/planhistory/types";
import type { IAutonomousPlanHistoryService } from "../src/planhistory/interfaces";
import type { AutonomousPlanSequencingEntry, AutonomousPlanSequencingReport } from "../src/plansequencing/types";
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

function sequencingEntry(overrides: Partial<AutonomousPlanSequencingEntry> & Pick<AutonomousPlanSequencingEntry, "repositoryId" | "sourceRecommendationKind" | "level">): AutonomousPlanSequencingEntry {
  return { cycleCount: 0, ...overrides };
}

function sequencingReport(entries: AutonomousPlanSequencingEntry[], currentness: AutonomousPlanSequencingReport["summary"]["currentness"] = "current"): AutonomousPlanSequencingReport {
  const levelBreakdown = { high: 0, medium: 0, low: 0 };
  for (const entry of entries) {
    levelBreakdown[entry.level] += 1;
  }
  return {
    generatedAt: new Date(),
    summary: { entriesSequenced: entries.length, currentness, levelBreakdown },
    entries,
  };
}

function verifyAutonomousPlanSchedulingEngine(): void {
  const engine = new AutonomousPlanSchedulingEngine();

  // Empty sequence -> empty schedule
  {
    const report = engine.schedule(sequencingReport([]));
    assert(report.entries.length === 0, "no sequenced entries -> empty entries, not a fabricated fallback");
    assert(report.summary.entriesScheduled === 0, "no sequenced entries -> entriesScheduled is 0");
  }

  // Cadence classification: low -> frequent, medium -> periodic, high -> infrequent
  {
    const low = engine.schedule(sequencingReport([sequencingEntry({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", level: "low" })]));
    assert(low.entries[0].cadence === "frequent", "readiness level low -> cadence frequent");
  }
  {
    const medium = engine.schedule(sequencingReport([sequencingEntry({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", level: "medium" })]));
    assert(medium.entries[0].cadence === "periodic", "readiness level medium -> cadence periodic");
  }
  {
    const high = engine.schedule(sequencingReport([sequencingEntry({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", level: "high" })]));
    assert(high.entries[0].cadence === "infrequent", "readiness level high -> cadence infrequent");
  }

  // Order preservation: Scheduling never re-sorts Plan Sequencing's own order
  {
    const entries = [
      sequencingEntry({ repositoryId: "gamma", sourceRecommendationKind: "PullRequired", level: "high" }),
      sequencingEntry({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", level: "low" }),
      sequencingEntry({ repositoryId: "beta", sourceRecommendationKind: "PullRequired", level: "medium" }),
    ];
    const report = engine.schedule(sequencingReport(entries));
    assert(
      report.entries.map((e) => e.repositoryId).join(",") === "gamma,alpha,beta",
      "entries keep the exact order Plan Sequencing produced (high, low, medium) -- Scheduling enriches in place, it never re-sorts by cadence or anything else",
    );
  }

  // Carried-forward fields: level and cycleCount, never recomputed
  {
    const report = engine.schedule(sequencingReport([sequencingEntry({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", level: "medium", cycleCount: 6 })]));
    assert(report.entries[0].level === "medium" && report.entries[0].cycleCount === 6, "level and cycleCount are carried forward from AutonomousPlanSequencingEntry unchanged");
  }

  // Summary fields
  {
    const entries = [
      sequencingEntry({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", level: "low" }),
      sequencingEntry({ repositoryId: "beta", sourceRecommendationKind: "PullRequired", level: "low" }),
      sequencingEntry({ repositoryId: "gamma", sourceRecommendationKind: "PullRequired", level: "high" }),
    ];
    const report = engine.schedule(sequencingReport(entries, "diverged"));
    assert(report.summary.currentness === "diverged", "summary.currentness carries forward the sequencing report's own plan-level fact unchanged");
    assert(report.summary.entriesScheduled === 3, "entriesScheduled matches the number of entries scheduled");
    assert(report.summary.cadenceBreakdown.frequent === 2 && report.summary.cadenceBreakdown.infrequent === 1 && report.summary.cadenceBreakdown.periodic === 0, "cadenceBreakdown counts entries by their derived cadence");
  }

  // No numeric interval, minute, duration, or timer field appears anywhere in the output shape
  {
    const report = engine.schedule(sequencingReport([sequencingEntry({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", level: "medium" })]));
    const forbiddenKeys = [
      "suggestedIntervalMinutes",
      "intervalMinutes",
      "interval",
      "minutes",
      "duration",
      "durationMs",
      "cadenceMs",
      "timer",
      "nextRun",
      "scheduledAt",
      "dueAt",
      "windowMs",
      "approved",
      "eligible",
      "requiresReview",
      "execute",
    ];
    const allKeys = [...Object.keys(report), ...Object.keys(report.summary), ...Object.keys(report.entries[0])];
    assert(!forbiddenKeys.some((forbidden) => allKeys.includes(forbidden)), "no numeric interval/duration/timer/approval/eligibility/execution field exists anywhere in the report shape -- cadence is a classification only");
    assert(typeof report.entries[0].cadence === "string", "cadence is a string classification, never a number");
  }

  // Purity: calling schedule() twice with the same input produces identical output
  {
    const input = sequencingReport([
      sequencingEntry({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", level: "medium", cycleCount: 2 }),
      sequencingEntry({ repositoryId: "beta", sourceRecommendationKind: "PullRequired", level: "low", cycleCount: 1 }),
    ]);
    const first = engine.schedule(input);
    const second = engine.schedule(input);
    assert(
      JSON.stringify({ ...first, generatedAt: undefined }) === JSON.stringify({ ...second, generatedAt: undefined }),
      "schedule() is a pure function -- identical input produces identical output, no internal state to drift",
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
    const recommendation: Recommendation = { kind: "PullRequired", category: "informational", priority: "low", reason: "test", supportingEvidence: [] };
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
    category: "informational",
    priority: "low",
    reason: "test",
    supportingEvidence: [],
    confidence: "low",
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
  // Recorded history whose sole cycle exactly matches the live plan
  // (informational category -> low confidence, per AutonomousPlanningEngine's
  // confidenceFor()) so the live plan compares as "current" and its readiness
  // level lands on "low" -> cadence "frequent".
  const evolutionEngine = new AutonomousPlanEvolutionEngine();
  const recordedPlan = plan("recorded-1", [
    item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", category: "informational", priority: "low", confidence: "low" }),
  ]);
  const recordedEntry = historyEntry(1, recordedPlan, evolutionEngine.analyze(undefined, recordedPlan, 1));
  const historyService = new RecordingAutonomousPlanHistoryService([recordedEntry]);

  const stateEngine = new AutonomousPlanStateEngine(evolutionEngine);
  const analysisEngine = new AutonomousPlanningAnalysisEngine();
  const autonomousPlanningService = new AutonomousPlanningService(historyService, stateEngine, analysisEngine);
  const readinessEngine = new AutonomousPlanReadinessEngine();
  const sequencingEngine = new AutonomousPlanSequencingEngine();
  const schedulingEngine = new AutonomousPlanSchedulingEngine();

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
  );

  const scheduleReport = await applicationService.getAutonomousPlanSchedule();

  assert(scheduleReport.entries.length === 1, "getAutonomousPlanSchedule() schedules exactly the one item the live plan produced");
  assert(scheduleReport.entries[0].repositoryId === "alpha" && scheduleReport.entries[0].sourceRecommendationKind === "PullRequired", "the scheduled entry's identity matches the live plan's own item");
  assert(scheduleReport.entries[0].level === "low", "level is carried forward from the readiness assessment (informational category -> low confidence -> low level)");
  assert(scheduleReport.entries[0].cadence === "frequent", "low readiness level -> cadence frequent");
  assert(scheduleReport.summary.currentness === "current", "summary.currentness carries forward the sequencing report's own currentness fact");

  assert(historyService.recordCalls === 0, "getAutonomousPlanSchedule() never calls IAutonomousPlanHistoryService.record(), anywhere in the chain");

  // Cross-check: scheduling the same sequence report fetched independently
  // produces the same result -- proving getAutonomousPlanSchedule() is
  // honestly composing Plan Sequencing data, not something else.
  const independentSequence = await applicationService.getAutonomousPlanSequence();
  const independentSchedule = schedulingEngine.schedule(independentSequence);
  assert(
    JSON.stringify({ ...scheduleReport, generatedAt: undefined }) === JSON.stringify({ ...independentSchedule, generatedAt: undefined }),
    "getAutonomousPlanSchedule()'s result matches independently scheduling the same sequence report",
  );

  // Empty registry -> empty schedule
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
    );
    const emptySchedule = await emptyApplicationService.getAutonomousPlanSchedule();
    assert(emptySchedule.entries.length === 0, "no registered repositories -> an empty live plan -> an empty schedule");
    assert(emptyHistoryService.recordCalls === 0, "getAutonomousPlanSchedule() never calls record(), even against an empty history");
  }
}

async function main(): Promise<void> {
  verifyAutonomousPlanSchedulingEngine();
  await verifyApplicationServiceIntegration();
}

main();
