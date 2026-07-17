import type { PlanConfidence } from "../autonomy/types";
import type { AutonomousPlanAnalysisPattern } from "../plananalysis/types";
import type { RecommendationKind } from "../recommendations/types";

// The primary architectural contract for readiness consumers — a coarse,
// stable classification. Same three-tier vocabulary PlanConfidence and
// RecommendationPriority already use elsewhere: a magnitude descriptor, no
// verb, no implied obligation. Consumers should depend on this field, not
// on AutonomousPlanItemReadiness.score (see that field's own doc comment).
export type AutonomousPlanReadinessLevel = "low" | "medium" | "high";

// current:    the live plan matches the active recorded plan
// diverged:   an active plan exists but the live plan differs from it
// unrecorded: nothing has ever been recorded yet — a temporal fact, not a
//             negative judgment
export type PlanCurrentness = "current" | "diverged" | "unrecorded";

// Purely descriptive: answers "how ready does this item currently look,"
// never "should this be reviewed/approved/executed." Every field is either
// carried forward unchanged from an existing Planning-domain report, or a
// deterministic composite of those carried-forward facts — nothing here is
// a new judgment invented by this module.
export interface AutonomousPlanItemReadiness {
  repositoryId: string;
  sourceRecommendationKind: RecommendationKind;
  // Carried forward from AutonomousPlanItem (Phase 9.1), never recomputed.
  confidence: PlanConfidence;
  // Carried forward from AutonomousPlanItemAnalysis.patterns (Phase 9.5)
  // verbatim; empty array is a valid, complete result.
  observedIndicators: AutonomousPlanAnalysisPattern[];
  // Carried forward from the analysis window when the item appears there;
  // 0 when it does not (no notable multi-cycle signal observed).
  cycleCount: number;
  // Internal heuristic, NOT part of this model's public contract — the
  // weights/formula behind this number may change in a future phase
  // without notice, and future consumers must not branch on exact values
  // or ranges. `level` (derived from this value) is the field to depend
  // on. Retained here only for transparency into how `level` was reached,
  // not as a stable abstraction in its own right.
  score: number;
  level: AutonomousPlanReadinessLevel;
}

export interface AutonomousPlanReadinessSummary {
  itemsAssessed: number;
  // A plan-level fact, not per-item.
  currentness: PlanCurrentness;
  confidenceBreakdown: { high: number; medium: number; low: number };
  levelBreakdown: { high: number; medium: number; low: number };
  // Internal heuristic, same caveat as AutonomousPlanItemReadiness.score —
  // an aggregate of non-contractual values, provided for visibility only.
  averageScore: number;
}

export interface AutonomousPlanReadinessReport {
  generatedAt: Date;
  summary: AutonomousPlanReadinessSummary;
  items: AutonomousPlanItemReadiness[];
}
