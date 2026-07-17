import type { AutonomousPlanReadinessLevel, PlanCurrentness } from "../planreadiness/types";
import type { RecommendationKind } from "../recommendations/types";

// A classification only — never a duration, interval, or timer. Concrete
// timing policy (what "frequent" means in minutes, if anything) belongs to
// a future Runtime Policy/Configuration layer, deliberately not this
// domain.
export type AutonomousPlanSchedulingCadence = "frequent" | "periodic" | "infrequent";

// One item's cadence classification — identified by (repositoryId,
// sourceRecommendationKind), the same composite key used throughout this
// arc. `level` and `cycleCount` are carried forward from
// AutonomousPlanSequencingEntry unchanged, never recomputed; `cadence` is
// the one new fact this domain contributes.
export interface AutonomousPlanSchedulingEntry {
  repositoryId: string;
  sourceRecommendationKind: RecommendationKind;
  level: AutonomousPlanReadinessLevel;
  cycleCount: number;
  cadence: AutonomousPlanSchedulingCadence;
}

export interface AutonomousPlanSchedulingSummary {
  entriesScheduled: number;
  // A plan-level fact, carried forward from AutonomousPlanSequencingReport.summary.currentness.
  currentness: PlanCurrentness;
  cadenceBreakdown: { frequent: number; periodic: number; infrequent: number };
}

export interface AutonomousPlanSchedulingReport {
  generatedAt: Date;
  summary: AutonomousPlanSchedulingSummary;
  // Preserves AutonomousPlanSequencingReport.entries' own order verbatim —
  // this domain enriches each entry with a cadence classification, it
  // never re-sorts. Re-ranking here would duplicate Plan Sequencing's
  // already-reviewed ordering logic.
  entries: AutonomousPlanSchedulingEntry[];
}
