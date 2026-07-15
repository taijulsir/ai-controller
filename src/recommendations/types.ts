import type { Insight } from "../decisions/types";

export type RecommendationCategory = "blocking" | "advisory" | "informational";
export type RecommendationPriority = "critical" | "high" | "medium" | "low";

// The recommendation's identity, not a free-form message — human-readable
// text is ResponseFormatter's responsibility, not this engine's. Each kind
// name already communicates the suggested engineering action (e.g.
// PullRequired implies "pull"), so there is no separate "suggested action"
// field kept in lockstep with this one.
export type RecommendationKind =
  | "RepositoryReadyToShip"
  | "ContinueSession"
  | "ReviewPullRequest"
  | "PullRequired"
  | "RepeatedFailures"
  | "ReviewChanges";

export type RepositoryFact =
  | { name: "branchBehind"; behind: number }
  | { name: "workflowReadiness"; canShip: boolean }
  | { name: "openPullRequests"; count: number }
  | { name: "workingTree"; isClean: boolean; ahead: number };

export type SessionFact = { name: "sessionStatus"; status: "active" | "expired" | "none" };

// Evidence a recommendation is grounded in — never assumes every
// recommendation traces back to a DecisionEngine Insight; a repository or
// session fact read directly from already-computed data is just as valid.
export type SupportingEvidence =
  | { source: "insight"; insightKind: Insight["kind"] }
  | { source: "repository-fact"; fact: RepositoryFact }
  | { source: "session-fact"; fact: SessionFact };

export interface Recommendation {
  kind: RecommendationKind;
  category: RecommendationCategory;
  priority: RecommendationPriority;
  reason: string;
  supportingEvidence: SupportingEvidence[];
}

export interface RepositoryRecommendationReport {
  repositoryId: string;
  generatedAt: Date;
  // An empty array is a valid, complete result — no fallback "nothing to do"
  // entry is ever synthesized just to avoid returning zero recommendations.
  recommendations: Recommendation[];
}
