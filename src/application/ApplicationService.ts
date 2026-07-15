import type { IEngineeringAssistanceEngine } from "../assistance/interfaces";
import type { RepositoryAssistanceReport } from "../assistance/types";
import type { IDecisionEngine } from "../decisions/interfaces";
import type { RepositoryInsightReport } from "../decisions/types";
import type { IRepositoryIntelligenceService } from "../intelligence/interfaces";
import type { RepositorySnapshot } from "../intelligence/types";
import type { IProjectMemoryService } from "../memory/interfaces";
import type { ProjectMemoryEvent } from "../memory/types";
import type { IProactiveMonitor } from "../monitoring/interfaces";
import type { IRecommendationEngine } from "../recommendations/interfaces";
import type { RepositoryRecommendationReport } from "../recommendations/types";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import type { IClaudeSessionManager } from "../session/interfaces";
import type { ClaudeSessionInfo } from "../session/types";
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
