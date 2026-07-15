import type { Recommendation } from "../recommendations/types";
import type { MonitoringPolicy, RecommendationState, RecommendationTransition } from "./types";

// One record per (repositoryId, recommendationKind), holding only lifecycle
// metadata — no adapters, no process, no config dependency. Mirrors
// ClaudeSessionManager's own "pure metadata/policy store" shape exactly.
export class RecommendationStateStore {
  private readonly states = new Map<string, RecommendationState>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  // Reconciles the currently-active recommendations against tracked state:
  // creates a record for a newly-seen (repository, kind) pair, refreshes
  // lastSeen/category/priority for still-active ones, and drops records for
  // recommendations no longer present — a later reappearance starts a fresh
  // streak, eligible for delivery again. Returns only the transitions that
  // just became eligible for delivery this call; the state itself (not an
  // event) is what's persisted.
  reconcile(repositoryId: string, recommendations: Recommendation[], policy: MonitoringPolicy): RecommendationTransition[] {
    const nowValue = this.now();
    const activeKeys = new Set<string>();
    const transitions: RecommendationTransition[] = [];

    for (const recommendation of recommendations) {
      const key = this.key(repositoryId, recommendation.kind);
      activeKeys.add(key);

      const state = this.states.get(key) ?? this.createState(repositoryId, recommendation, nowValue);
      state.lastSeen = nowValue;
      state.category = recommendation.category;
      state.priority = recommendation.priority;
      this.states.set(key, state);

      if (this.isUrgent(state) && !state.urgentDelivered) {
        state.urgentDelivered = true;
        transitions.push({ state: { ...state }, trigger: "new-urgent-recommendation" });
      }

      const sustainedMs = nowValue.getTime() - state.firstSeen.getTime();
      if (!state.sustainedDelivered && sustainedMs >= policy.sustainedDurationMs) {
        state.sustainedDelivered = true;
        transitions.push({ state: { ...state }, trigger: "sustained-recommendation" });
      }
    }

    this.dropInactiveStates(repositoryId, activeKeys);

    return transitions;
  }

  private createState(repositoryId: string, recommendation: Recommendation, now: Date): RecommendationState {
    return {
      repositoryId,
      recommendationKind: recommendation.kind,
      category: recommendation.category,
      priority: recommendation.priority,
      firstSeen: now,
      lastSeen: now,
      urgentDelivered: false,
      sustainedDelivered: false,
    };
  }

  private isUrgent(state: RecommendationState): boolean {
    return state.category === "blocking" || state.priority === "critical" || state.priority === "high";
  }

  private dropInactiveStates(repositoryId: string, activeKeys: Set<string>): void {
    const prefix = `${repositoryId}:`;
    const staleKeys = [...this.states.keys()].filter((key) => key.startsWith(prefix) && !activeKeys.has(key));
    for (const key of staleKeys) {
      this.states.delete(key);
    }
  }

  private key(repositoryId: string, kind: string): string {
    return `${repositoryId}:${kind}`;
  }
}
