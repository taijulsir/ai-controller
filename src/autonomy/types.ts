import type { RecommendationCategory, RecommendationKind, RecommendationPriority, SupportingEvidence } from "../recommendations/types";

// How strongly Autonomous Planning itself stands behind an item — distinct
// from RecommendationKind/category/priority, all of which are
// RecommendationEngine's judgment about the underlying repository state.
// Confidence is Autonomous Planning's own, currently derived deterministically
// from `category` alone (see AutonomousPlanningEngine.confidenceFor) — the
// seed for later, richer autonomous reasoning and approval workflows, not a
// final scoring model.
export type PlanConfidence = "low" | "medium" | "high";

// A planning-oriented item, not a copy of Recommendation: `repositoryId`
// gives it identity outside any enclosing per-repo report, `confidence` is
// new judgment Autonomous Planning itself contributes, and
// `sourceRecommendationKind` is deliberately not named `recommendationKind` —
// RecommendationEngine remains the sole owner of what a RecommendationKind
// means; this field only ever references a value that module already
// produced. `category`, `priority`, `reason`, and `supportingEvidence` are
// carried forward unchanged from the originating Recommendation — Autonomous
// Planning never recomputes or reinterprets evidence, it only adds ranking
// and confidence on top of it.
export interface AutonomousPlanItem {
  repositoryId: string;
  sourceRecommendationKind: RecommendationKind;
  category: RecommendationCategory;
  priority: RecommendationPriority;
  reason: string;
  supportingEvidence: SupportingEvidence[];
  confidence: PlanConfidence;
}

export interface AutonomousPlan {
  // Unique per synthesis — future traceability (history, approvals, runtime
  // logs, telemetry) needs a stable handle for one specific plan, distinct
  // from `generatedAt` (which two plans could theoretically share).
  id: string;
  generatedAt: Date;
  // Every repository a report was collected for this cycle, regardless of
  // whether it contributed any items — lets a reader distinguish "this repo
  // is genuinely clean" from "this repo wasn't considered at all".
  repositoriesConsidered: string[];
  // Cross-repository, priority-ranked: items[0] is the single most urgent
  // thing across the whole portfolio right now. Ordering is this model's own
  // contribution; every other field on an item is carried forward, not
  // recomputed.
  items: AutonomousPlanItem[];
}
