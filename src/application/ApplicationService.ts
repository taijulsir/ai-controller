import type { IRuntimeAdministrationService } from "../admin/interfaces";
import type { IEngineeringAssistanceEngine } from "../assistance/interfaces";
import type { RepositoryAssistanceReport } from "../assistance/types";
import type { IAutonomousPlanningEngine } from "../autonomy/interfaces";
import type { AutonomousPlan } from "../autonomy/types";
import type { IRuntimeControlService } from "../control/interfaces";
import type { IDecisionEngine } from "../decisions/interfaces";
import type { RepositoryInsightReport } from "../decisions/types";
import type { IRuntimeDiagnosticsEngine } from "../diagnostics/interfaces";
import type { RuntimeDiagnosticsReport } from "../diagnostics/types";
import type { IRepositoryIntelligenceService } from "../intelligence/interfaces";
import type { RepositorySnapshot } from "../intelligence/types";
import type { IProjectMemoryService } from "../memory/interfaces";
import type { ProjectMemoryEvent } from "../memory/types";
import type { IProactiveMonitor } from "../monitoring/interfaces";
import type { IRecommendationEngine } from "../recommendations/interfaces";
import type { RepositoryRecommendationReport } from "../recommendations/types";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import type { IRuntimeReportingEngine } from "../reporting/interfaces";
import type { RuntimeReport } from "../reporting/types";
import type { IClaudeSessionManager } from "../session/interfaces";
import type { ClaudeSessionInfo } from "../session/types";
import type { IRuntimeStatusService } from "../status/interfaces";
import type { RuntimeStatus } from "../status/types";
import type { EngineeringWorkspace } from "../workspace/types";
import { NoActiveRepositoryError } from "./errors";
import type { IApplicationService } from "./interfaces";

export class ApplicationService implements IApplicationService {
  constructor(
    private readonly repositoryIntelligence: IRepositoryIntelligenceService,
    private readonly projectMemory: IProjectMemoryService,
    private readonly decisionEngine: IDecisionEngine,
    private readonly sessionManager: IClaudeSessionManager,
    private readonly repositoryRegistry: IRepositoryRegistry,
    private readonly recommendationEngine: IRecommendationEngine,
    private readonly engineeringAssistanceEngine: IEngineeringAssistanceEngine,
    // Phase 8.5: the composition root actually passes a DeferredRuntimeStatusService
    // here (bound to the real RuntimeStatusService later, once the Background
    // Runtime cluster is built) — see DeferredRuntimeStatusService's own doc
    // comment for why that seam exists. From this class's perspective it is
    // simply an IRuntimeStatusService, exactly like every other dependency.
    private readonly runtimeStatusService: IRuntimeStatusService,
    // Phase 8.8: zero constructor dependencies of its own (a pure transform,
    // like PlanningEngine/ExecutionCoordinator/RecommendationEngine) — no
    // deferred seam is needed for this one, unlike the three runtime-facade
    // dependencies below, since it never reaches back toward
    // ApplicationService or anything else.
    private readonly runtimeDiagnosticsEngine: IRuntimeDiagnosticsEngine,
    // Phase 8.9: zero constructor dependencies of its own, same shape as
    // runtimeDiagnosticsEngine above — no deferred seam needed.
    private readonly runtimeReportingEngine: IRuntimeReportingEngine,
    // Phase 8.6: same seam shape as runtimeStatusService above — the
    // composition root actually passes a DeferredRuntimeControlService here,
    // bound to the real RuntimeControlService once the Background Runtime
    // cluster exists. From this class's perspective it is simply an
    // IRuntimeControlService.
    private readonly runtimeControlService: IRuntimeControlService,
    // Phase 8.7: same seam shape as the two above — the composition root
    // actually passes a DeferredRuntimeAdministrationService here, bound to
    // the real RuntimeAdministrationService once the Background Runtime
    // cluster exists.
    private readonly runtimeAdministrationService: IRuntimeAdministrationService,
    // Phase 9.1: zero constructor dependencies of its own (a pure transform,
    // like recommendationEngine/engineeringAssistanceEngine/
    // runtimeDiagnosticsEngine/runtimeReportingEngine above) — no deferred
    // seam needed, since it never reaches back toward ApplicationService or
    // anything else.
    private readonly autonomousPlanningEngine: IAutonomousPlanningEngine,
    // Optional: Engineering Workspace must compose successfully whether or
    // not a monitoring service exists in this deployment. Monitoring is not
    // wired into the composition root yet (Phase 7.7's scheduler/runtime
    // integration is still a later phase) — when absent, attentionEvents is
    // simply undefined; nothing here infers or fabricates a substitute.
    private readonly proactiveMonitor?: IProactiveMonitor,
  ) {}

  async getRepositoryStatus(repositoryId?: string): Promise<RepositorySnapshot> {
    return this.repositoryIntelligence.getSnapshot(this.resolveRepositoryId(repositoryId));
  }

  async getRepositoryHistory(repositoryId?: string, limit?: number): Promise<ProjectMemoryEvent[]> {
    return this.projectMemory.getRecentEvents({ repositoryId: this.resolveRepositoryId(repositoryId), limit });
  }

  async getRepositoryInsights(repositoryId?: string): Promise<RepositoryInsightReport> {
    const resolvedId = this.resolveRepositoryId(repositoryId);
    const snapshot = await this.repositoryIntelligence.getSnapshot(resolvedId);
    return this.decisionEngine.analyze(snapshot);
  }

  getSessionStatus(repositoryId?: string): ClaudeSessionInfo | undefined {
    return this.sessionManager.getSessionStatus(this.resolveRepositoryId(repositoryId));
  }

  // Fetches the snapshot and analyzes it exactly once, then hands both —
  // plus the current session status — to the pure RecommendationEngine.
  // Mirrors getRepositoryInsights()'s own fetch-once discipline; no data
  // this method reads is ever recomputed a second time.
  async getRecommendations(repositoryId?: string): Promise<RepositoryRecommendationReport> {
    const resolvedId = this.resolveRepositoryId(repositoryId);
    const snapshot = await this.repositoryIntelligence.getSnapshot(resolvedId);
    const insightReport = await this.decisionEngine.analyze(snapshot);
    const session = this.sessionManager.getSessionStatus(resolvedId);
    return this.recommendationEngine.recommend(snapshot, insightReport, session);
  }

  // Reuses getRecommendations() rather than re-deriving anything: the
  // already-computed, already-prioritized RepositoryRecommendationReport is
  // handed straight to the pure EngineeringAssistanceEngine.
  async getEngineeringAssistance(repositoryId?: string): Promise<RepositoryAssistanceReport> {
    const recommendationReport = await this.getRecommendations(repositoryId);
    return this.engineeringAssistanceEngine.propose(recommendationReport);
  }

  // Pure composition — every analysis-producing call happens exactly once
  // (the snapshot is fetched once and reused for insights/recommendations;
  // recommendations are computed once and reused for assistance), then
  // assembled directly rather than routed back through this class's own
  // sibling methods, which would each independently re-fetch/re-analyze.
  //
  // When a monitoring service is available, calling its evaluate() here is
  // a deliberate, real "check-in" — not a side-effect accident. Monitoring
  // alone owns its state-transition/dedup semantics regardless of who
  // calls evaluate() or when; this composition is simply one legitimate
  // caller among any others that may exist later.
  async getEngineeringWorkspace(repositoryId?: string): Promise<EngineeringWorkspace> {
    const resolvedId = this.resolveRepositoryId(repositoryId);
    const snapshot = await this.repositoryIntelligence.getSnapshot(resolvedId);
    const insightReport = await this.decisionEngine.analyze(snapshot);
    const session = this.sessionManager.getSessionStatus(resolvedId);
    const recommendationReport = this.recommendationEngine.recommend(snapshot, insightReport, session);
    const assistanceReport = this.engineeringAssistanceEngine.propose(recommendationReport);
    const recentHistory = await this.projectMemory.getRecentEvents({ repositoryId: resolvedId });
    const attentionEvents = this.proactiveMonitor ? await this.proactiveMonitor.evaluate(resolvedId) : undefined;

    return {
      repositoryId: resolvedId,
      generatedAt: new Date(),
      repository: snapshot,
      insights: insightReport,
      recommendations: recommendationReport,
      assistance: assistanceReport,
      session,
      recentHistory,
      attentionEvents,
    };
  }

  // Phase 8.5: pure delegation, no additional logic — RuntimeStatusService
  // already assembles the full immutable snapshot; this method exists only
  // so Telegram/future front-ends have exactly one read-facade to depend on,
  // matching every other query this class exposes.
  getRuntimeStatus(): RuntimeStatus {
    return this.runtimeStatusService.getStatus();
  }

  // Phase 8.6: pure delegation — returns the held reference itself, no
  // orchestration. Whoever calls a method on the returned object reaches
  // RuntimeControlService directly.
  getRuntimeControl(): IRuntimeControlService {
    return this.runtimeControlService;
  }

  // Phase 8.7: pure delegation — returns the held reference itself, no
  // orchestration.
  getRuntimeAdministration(): IRuntimeAdministrationService {
    return this.runtimeAdministrationService;
  }

  // Phase 8.8: orchestration only, same fetch-once-then-analyze shape as
  // getRepositoryInsights() (getSnapshot() then decisionEngine.analyze()) —
  // fetch the RuntimeStatus exactly once, hand it to the pure
  // RuntimeDiagnosticsEngine, return what it produces. No branching, no
  // interpretation, no message assembly happens here.
  getRuntimeDiagnosis(): RuntimeDiagnosticsReport {
    const status = this.runtimeStatusService.getStatus();
    return this.runtimeDiagnosticsEngine.diagnose(status);
  }

  // Phase 8.9: fetches RuntimeStatus exactly once and reuses that same
  // object for both diagnose() and buildReport() — deliberately does NOT
  // call getRuntimeDiagnosis() (which would fetch a second, independent
  // RuntimeStatus snapshot), since the report's raw-facts sections and its
  // diagnosis must describe the exact same instant, not two separately
  // fetched reads that could disagree.
  getRuntimeReport(): RuntimeReport {
    const status = this.runtimeStatusService.getStatus();
    const diagnostics = this.runtimeDiagnosticsEngine.diagnose(status);
    return this.runtimeReportingEngine.buildReport(status, diagnostics);
  }

  // Phase 9.1: portfolio-wide, unlike every other method here — reuses
  // getRecommendations() once per registered repository (itself already
  // fetch-once per repository) rather than re-deriving any snapshot,
  // insight, or session data. Promise.allSettled() means one repository
  // failing to produce a report (e.g. an unreachable path) degrades that
  // repository out of the plan instead of aborting portfolio-wide planning
  // for every other repository — the same graceful-degradation precedent
  // RepositoryIntelligenceService already established for its own
  // multi-source fan-out. The pure AutonomousPlanningEngine only ever sees
  // the reports that actually succeeded.
  async getAutonomousPlan(): Promise<AutonomousPlan> {
    const repositories = this.repositoryRegistry.getAllRepositories();
    const settled = await Promise.allSettled(repositories.map((repository) => this.getRecommendations(repository.id)));
    const reports = settled
      .filter((outcome): outcome is PromiseFulfilledResult<RepositoryRecommendationReport> => outcome.status === "fulfilled")
      .map((outcome) => outcome.value);
    return this.autonomousPlanningEngine.buildPlan(reports);
  }

  private resolveRepositoryId(repositoryId?: string): string {
    if (repositoryId) {
      return repositoryId;
    }
    const activeRepository = this.repositoryRegistry.getActiveRepository();
    if (!activeRepository) {
      throw new NoActiveRepositoryError();
    }
    return activeRepository.id;
  }
}
