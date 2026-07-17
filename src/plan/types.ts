import type { AutonomousPlan } from "../autonomy/types";
import type { AutonomousPlanHistoryEntry } from "../planhistory/types";
import type { AutonomousPlanState, LivePlanComparison } from "../planstate/types";

// One recorded cycle's full picture — the raw entry (which already carries
// its own baked-in evolution, per Phase 9.2) paired with its derived
// active/superseded state (Phase 9.3). Fetched and derived from a single
// history read, never two independent reads that could disagree.
export interface AutonomousPlanCycleSummary {
  entry: AutonomousPlanHistoryEntry;
  state: AutonomousPlanState;
}

// "Is the live view of the world still in sync with what was last recorded,
// and what's currently authoritative." currentState and comparison are
// derived from the exact same active-entry fetch — they can never describe
// two different instants.
export interface AutonomousPlanningSnapshot {
  generatedAt: Date;
  plan: AutonomousPlan;
  currentState: AutonomousPlanState | undefined;
  comparison: LivePlanComparison;
}
