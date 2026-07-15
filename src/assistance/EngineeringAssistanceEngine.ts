import type { Recommendation, RecommendationKind, RepositoryRecommendationReport } from "../recommendations/types";
import type { IEngineeringAssistanceEngine } from "./interfaces";
import type { AssistanceActionKind, EngineeringProposal, RepositoryAssistanceReport, SuggestedAction } from "./types";

function action(kind: AssistanceActionKind, isPrimary: boolean, isDismissal: boolean): SuggestedAction {
  return { kind, isPrimary, isDismissal };
}

// One fixed action set per RecommendationKind. "Continue Anyway" (repeated
// failures) and "Continue" (an active session) are the same underlying
// engineering action — proceeding with the current implementation work — so
// RepeatedFailures's non-primary choice deliberately reuses
// ContinueCurrentSession rather than inventing a distinct kind for it.
// InspectPullRequest always means reviewing the *existing* open pull
// request, never creating a new one — ReviewPullRequest's own reason
// ("...before opening another") already establishes that opening another is
// exactly what should NOT happen here.
const ACTIONS_BY_KIND: Record<RecommendationKind, SuggestedAction[]> = {
  RepositoryReadyToShip: [
    action("ExecuteShipWorkflow", true, false),
    action("InspectRepository", false, false),
    action("DismissSuggestion", false, true),
  ],
  RepeatedFailures: [
    action("InspectRepository", true, false),
    action("ContinueCurrentSession", false, false),
  ],
  PullRequired: [
    action("PullLatestChanges", true, false),
    action("DismissSuggestion", false, true),
  ],
  ReviewPullRequest: [
    action("InspectPullRequest", true, false),
    action("DismissSuggestion", false, true),
  ],
  ContinueSession: [
    action("ContinueCurrentSession", true, false),
    action("DismissSuggestion", false, true),
  ],
  ReviewChanges: [
    action("InspectRepository", true, false),
    action("DismissSuggestion", false, true),
  ],
};

// Pure transform: no constructor dependencies, no I/O, synchronous — same
// shape as RecommendationEngine/PlanningEngine/ExecutionCoordinator. It only
// ever relabels an already-computed Recommendation[] into engineering-
// oriented suggested actions; it never calls RecommendationEngine (or
// anything else) itself, so there is no way for it to recompute or
// duplicate what already produced the recommendations it's handed. Proposal
// order mirrors RecommendationEngine's own priority ordering, preserved
// rather than recomputed; each action's primacy is an explicit isPrimary
// flag, never inferred from array position.
export class EngineeringAssistanceEngine implements IEngineeringAssistanceEngine {
  propose(report: RepositoryRecommendationReport): RepositoryAssistanceReport {
    return {
      repositoryId: report.repositoryId,
      generatedAt: new Date(),
      proposals: report.recommendations.map((recommendation) => this.toProposal(recommendation)),
    };
  }

  private toProposal(recommendation: Recommendation): EngineeringProposal {
    return {
      recommendationKind: recommendation.kind,
      category: recommendation.category,
      priority: recommendation.priority,
      reason: recommendation.reason,
      actions: ACTIONS_BY_KIND[recommendation.kind],
      generatedAt: new Date(),
    };
  }
}
