import type { AutonomousPlanReadinessLevel, PlanCurrentness } from "../planreadiness/types";
import type { RecommendationKind } from "../recommendations/types";

// One item's position in the descriptive consideration order — identified
// by (repositoryId, sourceRecommendationKind), the same composite key used
// throughout this arc. `level` and `cycleCount` are carried forward from
// AutonomousPlanItemReadiness unchanged, never recomputed. Deliberately no
// index/position field: array position in
// AutonomousPlanSequencingReport.entries IS the order, the same convention
// AutonomousPlan.items already established (Phase 9.1) rather than a
// redundant, independently-maintainable field.
export interface AutonomousPlanSequencingEntry {
  repositoryId: string;
  sourceRecommendationKind: RecommendationKind;
  level: AutonomousPlanReadinessLevel;
  cycleCount: number;
}

export interface AutonomousPlanSequencingSummary {
  entriesSequenced: number;
  // A plan-level fact, carried forward from AutonomousPlanReadinessReport.summary.currentness.
  currentness: PlanCurrentness;
  levelBreakdown: { high: number; medium: number; low: number };
}

export interface AutonomousPlanSequencingReport {
  generatedAt: Date;
  summary: AutonomousPlanSequencingSummary;
  // Already in descriptive consideration order.
  entries: AutonomousPlanSequencingEntry[];
}
