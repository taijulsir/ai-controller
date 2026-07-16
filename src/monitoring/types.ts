import type { RecommendationCategory, RecommendationKind, RecommendationPriority } from "../recommendations/types";

// Lifecycle of a single (repository, recommendation kind) pair across polls.
// Purely metadata — no adapters, no I/O, same "pure policy store" shape as
// ClaudeSessionManager. AttentionEvents are derived from transitions in this
// state; the state itself is what's tracked, never a log of events.
export interface RecommendationState {
  repositoryId: string;
  recommendationKind: RecommendationKind;
  category: RecommendationCategory;
  priority: RecommendationPriority;
  firstSeen: Date;
  lastSeen: Date;
  urgentDelivered: boolean;
  sustainedDelivered: boolean;
}

// Timing thresholds as a plain value, not logic — policy stays separate from
// monitoring logic, and can change without redesigning ProactiveMonitor.
//
// Unrelated to src/policy's RuntimePolicyEngine (Phase 8.4) despite the
// similar name: this is ProactiveMonitor's own internal dedup-timing
// threshold (how long a still-active recommendation must persist before its
// "sustained" event fires) — a content-aware detail of monitoring's own
// analysis. RuntimePolicyEngine answers a different, operational question
// ("is monitoring/notification currently permitted at all") and knows
// nothing about recommendation kinds, transitions, or sustained-duration
// math. Neither should be merged into the other.
export interface MonitoringPolicy {
  sustainedDurationMs: number;
}

export type AttentionTrigger = "new-urgent-recommendation" | "sustained-recommendation";

// A transition out of RecommendationState that just became eligible for
// delivery this evaluation — the raw material AttentionEvents are derived
// from, not a stored record itself.
export interface RecommendationTransition {
  state: RecommendationState;
  trigger: AttentionTrigger;
}

// Transport-neutral: this module has no concept of Telegram, notifications,
// or delivery — it only decides that something deserves attention.
export interface AttentionEvent {
  repositoryId: string;
  trigger: AttentionTrigger;
  recommendationKind: RecommendationKind;
  category: RecommendationCategory;
  priority: RecommendationPriority;
  reason: string;
  generatedAt: Date;
}
