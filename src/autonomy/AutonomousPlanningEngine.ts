import { randomUUID } from "node:crypto";
import type { Recommendation, RecommendationCategory, RecommendationPriority, RepositoryRecommendationReport } from "../recommendations/types";
import type { IAutonomousPlanningEngine } from "./interfaces";
import type { AutonomousPlan, AutonomousPlanItem, PlanConfidence } from "./types";

const PRIORITY_ORDER: Record<RecommendationPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const CATEGORY_ORDER: Record<RecommendationCategory, number> = { blocking: 0, advisory: 1, informational: 2 };

// Pure synthesis, same shape as RecommendationEngine/EngineeringAssistanceEngine/
// PlanningEngine/ExecutionCoordinator: no constructor dependencies, no I/O,
// synchronous. It only ever combines RepositoryRecommendationReports its
// caller (ApplicationService) already fetched exactly once per repository —
// it never calls RecommendationEngine, RepositoryIntelligenceService,
// DecisionEngine, or ClaudeSessionManager itself, so it cannot recompute or
// duplicate what those already produced. It has no dependency capable of
// executing a Task/workflow, calling Claude, touching git/GitHub, sending a
// Telegram message, or reaching ControllerCore/ExecutionPipeline/
// ApprovalEngine/BackgroundRuntime — there is nothing here that could reach
// any of them, by construction. This engine is deliberately dormant: nothing
// in this phase schedules or wires it in.
export class AutonomousPlanningEngine implements IAutonomousPlanningEngine {
  buildPlan(reports: RepositoryRecommendationReport[]): AutonomousPlan {
    const items = reports
      .flatMap((report) => report.recommendations.map((recommendation) => this.toItem(report.repositoryId, recommendation)))
      .sort((a, b) => this.compare(a, b));

    return {
      id: randomUUID(),
      generatedAt: new Date(),
      repositoriesConsidered: reports.map((report) => report.repositoryId),
      items,
    };
  }

  private toItem(repositoryId: string, recommendation: Recommendation): AutonomousPlanItem {
    return {
      repositoryId,
      sourceRecommendationKind: recommendation.kind,
      category: recommendation.category,
      priority: recommendation.priority,
      reason: recommendation.reason,
      supportingEvidence: recommendation.supportingEvidence,
      confidence: this.confidenceFor(recommendation),
    };
  }

  // Deterministic and Phase-9.1-minimal: confidence tracks how directly the
  // underlying evidence supports acting on an item at all. Blocking findings
  // are grounded in hard repository facts or critical insights (unambiguous
  // -> high); advisory findings are softer judgment calls (medium);
  // informational findings carry the weakest signal (low). This is the seed
  // for later, richer autonomous reasoning — not a final scoring model.
  private confidenceFor(recommendation: Recommendation): PlanConfidence {
    switch (recommendation.category) {
      case "blocking":
        return "high";
      case "advisory":
        return "medium";
      case "informational":
        return "low";
    }
  }

  // Cross-repository ordering: priority first, then category, then
  // repositoryId for determinism when both are equal. This comparator is the
  // one place a future phase should extend if "what's next" needs richer
  // weighting (staleness, activity, business priority) — every call site
  // reuses it rather than re-deriving order on its own.
  private compare(a: AutonomousPlanItem, b: AutonomousPlanItem): number {
    const priorityDelta = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    const categoryDelta = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
    if (categoryDelta !== 0) {
      return categoryDelta;
    }
    return a.repositoryId.localeCompare(b.repositoryId);
  }
}
