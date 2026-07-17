import type { AutonomousPlan } from "../autonomy/types";
import type { RecommendationCategory, RecommendationKind, RecommendationPriority } from "../recommendations/types";

// Named for what these values describe — a difference observed between two
// planning cycles — not a lifecycle stage an item passes through on its own.
// "resolved" in particular is a one-time transition, not a state an item
// rests in: once reported, its (repositoryId, sourceRecommendationKind) key
// drops out of tracking (see AutonomousPlanEvolutionEngine), so it is never
// re-emitted on subsequent cycles just because the item is still absent.
export type PlanItemChangeType = "new" | "recurring" | "resolved" | "escalating";

// One item's change relative to the previous recorded cycle. Identified by
// (repositoryId, sourceRecommendationKind), the same composite key
// RecommendationState already uses for the analogous single-cycle dedup
// question — not a copy of the AutonomousPlanItem itself.
export interface AutonomousPlanItemTransition {
  repositoryId: string;
  sourceRecommendationKind: RecommendationKind;
  changeType: PlanItemChangeType;
  // Consecutive cycles this key has been observed, including this one.
  // Always 1 for "new". Carried forward from the previous cycle's own
  // transition for "recurring"/"escalating"/"resolved".
  cycleCount: number;
  // Current priority/category; for "resolved", the last-known values (there
  // is no "current" item to read them from).
  priority: RecommendationPriority;
  category: RecommendationCategory;
  // Present only for "escalating" — what the priority/category was last
  // cycle, so a reader can see the direction of change without fetching two
  // separate reports and diffing them by hand.
  previousPriority?: RecommendationPriority;
  previousCategory?: RecommendationCategory;
}

// The evolution of one recorded cycle relative to the one before it.
// Self-contained: carries its own identifying fields so it remains
// meaningful when read standalone (e.g. via
// ApplicationService.getLatestAutonomousPlanEvolution()), not only as a
// field nested inside AutonomousPlanHistoryEntry.
export interface AutonomousPlanEvolutionReport {
  // undefined only for the very first cycle ever recorded — there is no
  // fabricated "prior state" to compare against.
  previousPlanId: string | undefined;
  currentPlanId: string;
  cycleNumber: number;
  generatedAt: Date;
  transitions: AutonomousPlanItemTransition[];
}

// The persisted unit. cycleNumber is a property of the store (assigned at
// record time, monotonically increasing), not of the plan's own synthesis —
// AutonomousPlan.id stays a fresh UUID per instance and carries no ordering
// information, which is exactly why this field exists here instead of on
// AutonomousPlan itself. `evolution` is computed once, at the moment this
// entry is recorded, and persisted alongside it — a fixed historical fact,
// never recomputed on read.
export interface AutonomousPlanHistoryEntry {
  cycleNumber: number;
  recordedAt: Date;
  plan: AutonomousPlan;
  evolution: AutonomousPlanEvolutionReport;
}
