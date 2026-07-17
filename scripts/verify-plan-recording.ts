import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AutonomousPlanEvolutionEngine } from "../src/planhistory/AutonomousPlanEvolutionEngine";
import { AutonomousPlanHistoryService } from "../src/planhistory/AutonomousPlanHistoryService";
import { AutonomousPlanRecordingService } from "../src/planrecording/AutonomousPlanRecordingService";
import type { IAutonomousPlanRecordingService } from "../src/planrecording/interfaces";
import type { AutonomousPlan, AutonomousPlanItem } from "../src/autonomy/types";
import { AutonomousPlanningEngine } from "../src/autonomy/AutonomousPlanningEngine";
import type { IConfigService } from "../src/config/interfaces";
import type { ClaudeConfig, ControllerConfig, GithubConfig, TelegramConfig } from "../src/config/types";
import type { Repository } from "../src/domain/repository/Repository";
import type { AutonomousPlanHistoryEntry } from "../src/planhistory/types";
import type { IAutonomousPlanHistoryService } from "../src/planhistory/interfaces";
import { ApplicationService } from "../src/application/ApplicationService";
import type { IApplicationService } from "../src/application/interfaces";
import type { IRuntimeAdministrationService } from "../src/admin/interfaces";
import type { IEngineeringAssistanceEngine } from "../src/assistance/interfaces";
import type { RepositoryAssistanceReport } from "../src/assistance/types";
import type { IRuntimeControlService } from "../src/control/interfaces";
import type { IDecisionEngine } from "../src/decisions/interfaces";
import type { RepositoryInsightReport } from "../src/decisions/types";
import { RuntimeDiagnosticsEngine } from "../src/diagnostics/RuntimeDiagnosticsEngine";
import type { IRepositoryIntelligenceService } from "../src/intelligence/interfaces";
import type { RepositorySnapshot } from "../src/intelligence/types";
import type { IProjectMemoryService } from "../src/memory/interfaces";
import type { ProjectMemoryEvent } from "../src/memory/types";
import { AutonomousPlanningAnalysisEngine } from "../src/plananalysis/AutonomousPlanningAnalysisEngine";
import { AutonomousPlanReadinessEngine } from "../src/planreadiness/AutonomousPlanReadinessEngine";
import { AutonomousPlanSequencingEngine } from "../src/plansequencing/AutonomousPlanSequencingEngine";
import { AutonomousPlanSchedulingEngine } from "../src/scheduling/AutonomousPlanSchedulingEngine";
import { AutonomousPlanningService } from "../src/plan/AutonomousPlanningService";
import { AutonomousPlanStateEngine } from "../src/planstate/AutonomousPlanStateEngine";
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

// ---- AutonomousPlanRecordingService, in isolation ----

class RecordingAutonomousPlanHistoryService implements IAutonomousPlanHistoryService {
  public recordCalls = 0;
  public lastRecordedPlan: AutonomousPlan | undefined;
  constructor(private readonly latest: AutonomousPlanHistoryEntry | undefined = undefined, private readonly history: AutonomousPlanHistoryEntry[] = []) {}
  async record(plan: AutonomousPlan): Promise<AutonomousPlanHistoryEntry> {
    this.recordCalls += 1;
    this.lastRecordedPlan = plan;
    return { cycleNumber: this.recordCalls, recordedAt: new Date(), plan, evolution: { previousPlanId: undefined, currentPlanId: plan.id, cycleNumber: this.recordCalls, generatedAt: new Date(), transitions: [] } };
  }
  async getLatestEntry(): Promise<AutonomousPlanHistoryEntry | undefined> {
    return this.latest;
  }
  async getHistory(limit?: number): Promise<AutonomousPlanHistoryEntry[]> {
    return limit ? this.history.slice(0, limit) : this.history;
  }
}

async function verifyRecordingServiceInIsolation(): Promise<void> {
  const historyService = new RecordingAutonomousPlanHistoryService();
  const recordingService: IAutonomousPlanRecordingService = new AutonomousPlanRecordingService(historyService);

  const livePlan = plan("live-1", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
  const entry = await recordingService.recordAutonomousPlanCycle(livePlan);

  assert(historyService.recordCalls === 1, "recordAutonomousPlanCycle() delegates to IAutonomousPlanHistoryService.record() exactly once");
  assert(historyService.lastRecordedPlan === livePlan, "the exact plan instance handed in is the exact instance passed to record() -- no cloning, no re-synthesis");
  assert(entry.plan === livePlan, "the returned AutonomousPlanHistoryEntry carries the exact plan that was recorded");
  assert(entry.cycleNumber === 1, "the returned entry is exactly what IAutonomousPlanHistoryService.record() produced, not recomputed by this class");

  // A second call is a second, independent write -- this class holds no
  // state of its own and performs no dedup/idempotency check.
  const livePlan2 = plan("live-2", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })]);
  await recordingService.recordAutonomousPlanCycle(livePlan2);
  assert(historyService.recordCalls === 2, "a second call performs a second, independent record() call");
}

// ---- Real, on-disk AutonomousPlanHistoryService, through the new write path ----

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

async function verifyRecordingServiceOnRealStorage(): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "plan-recording-verify-"));
  try {
    const configService = new FakeConfigService(directory);
    const evolutionEngine = new AutonomousPlanEvolutionEngine();
    const historyService = new AutonomousPlanHistoryService(configService, evolutionEngine);
    const recordingService: IAutonomousPlanRecordingService = new AutonomousPlanRecordingService(historyService);

    assert((await historyService.getLatestEntry()) === undefined, "nothing recorded yet -- the real, on-disk store starts empty");

    const livePlan = plan("p1", [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", priority: "high", category: "blocking" })]);
    const entry = await recordingService.recordAutonomousPlanCycle(livePlan);
    assert(entry.cycleNumber === 1, "the first cycle ever recorded through the write path is assigned cycleNumber 1, exactly like calling historyService.record() directly");

    const rehydrated = await historyService.getLatestEntry();
    assert(rehydrated?.plan.id === "p1", "the cycle recorded through AutonomousPlanRecordingService is durably persisted -- reading it back via IAutonomousPlanHistoryService directly returns the exact same plan");
    assert(rehydrated?.recordedAt instanceof Date, "recordedAt round-trips as a real Date after persistence, same as calling record() directly");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// ---- ApplicationService.recordAutonomousPlanCycle() integration ----

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

async function verifyApplicationServiceIntegration(): Promise<void> {
  const evolutionEngine = new AutonomousPlanEvolutionEngine();
  const historyService = new RecordingAutonomousPlanHistoryService();
  const stateEngine = new AutonomousPlanStateEngine(evolutionEngine);
  const analysisEngine = new AutonomousPlanningAnalysisEngine();
  const autonomousPlanningService = new AutonomousPlanningService(historyService, stateEngine, analysisEngine);
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
    new AutonomousPlanReadinessEngine(),
    new AutonomousPlanSequencingEngine(),
    new AutonomousPlanSchedulingEngine(),
    recordingService,
  );

  // Every read method exposed by this class continues to never call
  // record() -- recordAutonomousPlanCycle() is the one exception, and only
  // when actually invoked.
  await applicationService.getAutonomousPlan();
  await applicationService.getAutonomousPlanHistory();
  await applicationService.getAutonomousPlanningSnapshot();
  await applicationService.getAutonomousPlanReadiness();
  await applicationService.getAutonomousPlanSequence();
  await applicationService.getAutonomousPlanSchedule();
  assert(historyService.recordCalls === 0, "every read method on ApplicationService still performs zero writes -- record() is reachable only via recordAutonomousPlanCycle()");

  const recorded = await applicationService.recordAutonomousPlanCycle();

  assert(historyService.recordCalls === 1, "recordAutonomousPlanCycle() calls IAutonomousPlanHistoryService.record() exactly once");
  assert(historyService.lastRecordedPlan === recorded.plan, "the exact plan instance recordAutonomousPlanCycle() fetched via getAutonomousPlan() is the exact instance handed to record() -- no cloning, no second synthesis");
  assert(recorded.plan.items[0].repositoryId === "alpha" && recorded.plan.items[0].sourceRecommendationKind === "PullRequired", "the recorded plan's item matches exactly what the live repository fan-out produced");

  // Calling it again performs a second, independent write -- no
  // idempotency/dedup guard exists at this layer.
  await applicationService.recordAutonomousPlanCycle();
  assert(historyService.recordCalls === 2, "calling recordAutonomousPlanCycle() twice performs two independent record() calls");

  // Empty registry -> an empty live plan is still a real plan, and still
  // gets recorded -- recordAutonomousPlanCycle() never special-cases an
  // empty plan into a no-op.
  const emptyHistoryService = new RecordingAutonomousPlanHistoryService();
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
    new AutonomousPlanningService(emptyHistoryService, stateEngine, analysisEngine),
    new AutonomousPlanReadinessEngine(),
    new AutonomousPlanSequencingEngine(),
    new AutonomousPlanSchedulingEngine(),
    new AutonomousPlanRecordingService(emptyHistoryService),
  );
  const emptyRecorded = await emptyApplicationService.recordAutonomousPlanCycle();
  assert(emptyHistoryService.recordCalls === 1, "an empty live plan (no registered repositories) is still recorded, not skipped");
  assert(emptyRecorded.plan.items.length === 0, "the recorded entry faithfully carries the empty live plan, not a fabricated fallback");
}

async function main(): Promise<void> {
  await verifyRecordingServiceInIsolation();
  await verifyRecordingServiceOnRealStorage();
  await verifyApplicationServiceIntegration();
}

main();
