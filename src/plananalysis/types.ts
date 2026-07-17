import type { RecommendationKind } from "../recommendations/types";

// Multiple patterns can apply to the same item at once (e.g. both chronic
// and currently escalating) -- deliberately an array, not a single label, so
// future pattern types can be added without breaking this model's shape.
export type AutonomousPlanAnalysisPattern = "chronic" | "sustained-escalation" | "flapping";

// One item's pattern classification over a window of recorded cycles.
// Identified by (repositoryId, sourceRecommendationKind), the same
// composite key AutonomousPlanItemTransition already uses -- not a copy of
// any single cycle's transition, priority, or category. A consumer wanting
// those already holds the AutonomousPlanCycleSummary[] this report was
// derived from and can cross-reference by key.
export interface AutonomousPlanItemAnalysis {
  repositoryId: string;
  sourceRecommendationKind: RecommendationKind;
  // Never empty when the item appears in the report at all -- "no pattern"
  // is absence from AutonomousPlanAnalysisReport.items, not an entry with
  // an empty array or a "stable" label.
  patterns: AutonomousPlanAnalysisPattern[];
  // From the item's most recent known transition within the window,
  // whether or not that transition is in the newest cycle.
  cycleCount: number;
  // Most-recent consecutive "escalating" cycles for this key; 0 whenever
  // the key is not escalating in the newest cycle (including when it is
  // entirely absent from it).
  consecutiveEscalations: number;
  // How many times this key reappeared as "new" after an earlier
  // appearance, within the observed window; 0 if it never flapped.
  flapCount: number;
}

export interface AutonomousPlanAnalysisSummary {
  cyclesAnalyzed: number;
  chronicCount: number;
  sustainedEscalationCount: number;
  flappingCount: number;
}

export interface AutonomousPlanAnalysisReport {
  generatedAt: Date;
  summary: AutonomousPlanAnalysisSummary;
  items: AutonomousPlanItemAnalysis[];
}
