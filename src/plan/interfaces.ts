import type { AutonomousPlan } from "../autonomy/types";
import type { AutonomousPlanState } from "../planstate/types";
import type { AutonomousPlanCycleSummary, AutonomousPlanningSnapshot } from "./types";

// Three consumer-oriented use cases over the recorded-planning domain
// (Phases 9.2/9.3), not a one-for-one mirror of IAutonomousPlanHistoryService/
// IAutonomousPlanStateEngine's own methods. Deliberately excludes live plan
// synthesis (Phase 9.1's getAutonomousPlan()) — see AutonomousPlanningService's
// own doc comment for why that boundary is held.
export interface IAutonomousPlanningService {
  // "What's authoritative right now" — lightweight, a single-entry fetch,
  // no live plan required.
  getCurrentPlanState(): Promise<AutonomousPlanState | undefined>;
  // "How has planning evolved over recent cycles" — one history fetch,
  // reused for both the raw entries and their derived states.
  getRecentCycles(limit?: number): Promise<AutonomousPlanCycleSummary[]>;
  // "Is my live view of the world still in sync with what's recorded, and
  // what would change if I recorded it now" — the live plan is supplied by
  // the caller (see the interface-level doc comment above), one active-entry
  // fetch reused for both currentState and comparison.
  getPlanningStatus(livePlan: AutonomousPlan): Promise<AutonomousPlanningSnapshot>;
}
