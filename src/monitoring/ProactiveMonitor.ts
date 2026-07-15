import type { IApplicationService } from "../application/interfaces";
import { RecommendationStateStore } from "./RecommendationStateStore";
import type { IProactiveMonitor } from "./interfaces";
import type { AttentionEvent, AttentionTrigger, MonitoringPolicy, RecommendationState } from "./types";

// Kept as an explicit, overridable value rather than inline inside
// ProactiveMonitor — policy stays separate from monitoring logic, and can be
// reconfigured later (e.g. from controller.yaml) without redesigning this
// class, same "kept internal for now" precedent DecisionEngine's own
// thresholds already established.
export const DEFAULT_MONITORING_POLICY: MonitoringPolicy = {
  sustainedDurationMs: 60 * 60 * 1000, // 1 hour
};

// Read-only: only ever calls ApplicationService.getRecommendations(), never
// RepositoryIntelligenceService/DecisionEngine/RecommendationEngine
// directly — it can never recompute or duplicate what those already
// produce. It has no dependency capable of executing a Task/workflow,
// calling Claude, or reaching ApprovalEngine, and it knows nothing about
// Telegram or any other transport: it only ever decides that something
// deserves attention, never how — or whether — that gets delivered.
export class ProactiveMonitor implements IProactiveMonitor {
  constructor(
    private readonly applicationService: IApplicationService,
    private readonly policy: MonitoringPolicy = DEFAULT_MONITORING_POLICY,
    private readonly stateStore: RecommendationStateStore = new RecommendationStateStore(),
  ) {}

  async evaluate(repositoryId?: string): Promise<AttentionEvent[]> {
    const report = await this.applicationService.getRecommendations(repositoryId);
    const transitions = this.stateStore.reconcile(report.repositoryId, report.recommendations, this.policy);

    return transitions.map(({ state, trigger }) => ({
      repositoryId: state.repositoryId,
      trigger,
      recommendationKind: state.recommendationKind,
      category: state.category,
      priority: state.priority,
      reason: this.describeTransition(state, trigger),
      generatedAt: new Date(),
    }));
  }

  private describeTransition(state: RecommendationState, trigger: AttentionTrigger): string {
    if (trigger === "new-urgent-recommendation") {
      return `"${state.recommendationKind}" is a new ${state.priority}-priority, ${state.category} recommendation.`;
    }
    const sustainedMinutes = Math.round(this.policy.sustainedDurationMs / 60_000);
    return `"${state.recommendationKind}" has remained active for at least ${sustainedMinutes} minute(s).`;
  }
}
