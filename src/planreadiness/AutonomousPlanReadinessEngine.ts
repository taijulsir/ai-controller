import type { AutonomousPlanItem, PlanConfidence } from "../autonomy/types";
import type { AutonomousPlanAnalysisPattern, AutonomousPlanAnalysisReport, AutonomousPlanItemAnalysis } from "../plananalysis/types";
import type { AutonomousPlanningSnapshot } from "../plan/types";
import type { LivePlanComparison } from "../planstate/types";
import type { RecommendationKind } from "../recommendations/types";
import type { IAutonomousPlanReadinessEngine } from "./interfaces";
import type {
  AutonomousPlanItemReadiness,
  AutonomousPlanReadinessLevel,
  AutonomousPlanReadinessReport,
  AutonomousPlanReadinessSummary,
  PlanCurrentness,
} from "./types";

// Internal heuristic constants — not part of this module's public contract
// (see AutonomousPlanItemReadiness.score's own doc comment). Free to retune
// without a model change, since `level` is the only field consumers should
// depend on.
const CONFIDENCE_BASE_SCORE: Record<PlanConfidence, number> = { high: 100, medium: 60, low: 20 };
const INDICATOR_DEDUCTIONS: Record<AutonomousPlanAnalysisPattern, number> = {
  flapping: 30,
  "sustained-escalation": 20,
  chronic: 10,
};
const HIGH_LEVEL_THRESHOLD = 70;
const MEDIUM_LEVEL_THRESHOLD = 40;

function itemKey(repositoryId: string, kind: RecommendationKind): string {
  return `${repositoryId}::${kind}`;
}

// Pure transform, same shape as every other engine in this arc: no
// constructor dependencies, no I/O, synchronous, no internal mutable state.
// Only ever sees an AutonomousPlanningSnapshot and an
// AutonomousPlanAnalysisReport its caller (ApplicationService) already
// fetched — it never calls AutonomousPlanningService itself, so it cannot
// recompute or duplicate what that façade already produced. It has no
// dependency capable of executing a Task/workflow, calling Claude, touching
// git/GitHub, sending a Telegram message, or reaching ControllerCore/
// ExecutionPipeline/ApprovalEngine/BackgroundRuntime.
//
// Strictly descriptive: every field on its output either carries forward an
// already-computed fact unchanged, or is a deterministic composite of those
// facts (score/level, currentness). Nothing here decides whether anything
// should happen, requires review, or is eligible for anything — that
// vocabulary is deliberately absent from this module by design, not by
// oversight.
export class AutonomousPlanReadinessEngine implements IAutonomousPlanReadinessEngine {
  assess(snapshot: AutonomousPlanningSnapshot, analysis: AutonomousPlanAnalysisReport): AutonomousPlanReadinessReport {
    const analysisByKey = new Map<string, AutonomousPlanItemAnalysis>(
      analysis.items.map((itemAnalysis) => [itemKey(itemAnalysis.repositoryId, itemAnalysis.sourceRecommendationKind), itemAnalysis]),
    );

    const items = snapshot.plan.items.map((item) =>
      this.assessItem(item, analysisByKey.get(itemKey(item.repositoryId, item.sourceRecommendationKind))),
    );

    return {
      generatedAt: new Date(),
      summary: this.buildSummary(items, snapshot.comparison),
      items,
    };
  }

  private assessItem(item: AutonomousPlanItem, itemAnalysis: AutonomousPlanItemAnalysis | undefined): AutonomousPlanItemReadiness {
    const observedIndicators = itemAnalysis?.patterns ?? [];
    const cycleCount = itemAnalysis?.cycleCount ?? 0;
    const score = this.computeScore(item.confidence, observedIndicators);

    return {
      repositoryId: item.repositoryId,
      sourceRecommendationKind: item.sourceRecommendationKind,
      confidence: item.confidence,
      observedIndicators,
      cycleCount,
      score,
      level: this.levelFor(score),
    };
  }

  private computeScore(confidence: PlanConfidence, indicators: AutonomousPlanAnalysisPattern[]): number {
    const deductions = indicators.reduce((total, indicator) => total + INDICATOR_DEDUCTIONS[indicator], 0);
    return Math.max(0, Math.min(100, CONFIDENCE_BASE_SCORE[confidence] - deductions));
  }

  private levelFor(score: number): AutonomousPlanReadinessLevel {
    if (score >= HIGH_LEVEL_THRESHOLD) {
      return "high";
    }
    if (score >= MEDIUM_LEVEL_THRESHOLD) {
      return "medium";
    }
    return "low";
  }

  private buildSummary(items: AutonomousPlanItemReadiness[], comparison: LivePlanComparison): AutonomousPlanReadinessSummary {
    const confidenceBreakdown = { high: 0, medium: 0, low: 0 };
    const levelBreakdown = { high: 0, medium: 0, low: 0 };
    let scoreSum = 0;

    for (const item of items) {
      confidenceBreakdown[item.confidence] += 1;
      levelBreakdown[item.level] += 1;
      scoreSum += item.score;
    }

    return {
      itemsAssessed: items.length,
      currentness: this.currentnessFor(comparison),
      confidenceBreakdown,
      levelBreakdown,
      averageScore: items.length === 0 ? 0 : scoreSum / items.length,
    };
  }

  private currentnessFor(comparison: LivePlanComparison): PlanCurrentness {
    if (!comparison.hasActivePlan) {
      return "unrecorded";
    }
    return comparison.matchesActivePlan ? "current" : "diverged";
  }
}
