import type { RecommendationCategory, RecommendationKind, RecommendationPriority } from "../recommendations/types";

// Engineering-oriented, not UI-oriented — presentation layers own rendering
// user-facing labels/button text from these, this module never produces
// display text of its own.
export type AssistanceActionKind =
  | "ExecuteShipWorkflow"
  | "InspectRepository"
  | "InspectPullRequest"
  | "ContinueCurrentSession"
  | "PullLatestChanges"
  | "DismissSuggestion";

export interface SuggestedAction {
  kind: AssistanceActionKind;
  // Explicit, not inferred from array position — a consumer must never rely
  // on actions[0] being the primary choice.
  isPrimary: boolean;
  isDismissal: boolean;
}

export interface EngineeringProposal {
  recommendationKind: RecommendationKind;
  category: RecommendationCategory;
  priority: RecommendationPriority;
  reason: string;
  actions: SuggestedAction[];
  generatedAt: Date;
}

export interface RepositoryAssistanceReport {
  repositoryId: string;
  generatedAt: Date;
  // Order mirrors RecommendationEngine's own priority ordering, preserved
  // rather than recomputed.
  proposals: EngineeringProposal[];
}
