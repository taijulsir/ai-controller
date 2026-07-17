import type { AutonomousPlanEvolutionReport } from "../planhistory/types";

// Named for what these values describe — a recorded plan's place within the
// history log — not an execution lifecycle. "active" means "the most
// recently recorded cycle," nothing more; it carries no claim about
// approval, readiness, or permission to execute.
export type PlanRecordStatus = "active" | "superseded";

// One recorded plan's status within history. Derived fresh from
// AutonomousPlanHistoryEntry ordering on every query — never itself stored,
// never a new field bolted onto AutonomousPlanHistoryEntry.
export interface AutonomousPlanState {
  planId: string;
  cycleNumber: number;
  status: PlanRecordStatus;
  recordedAt: Date;
  // Present only when status === "superseded" — the plan that directly
  // replaced this one. A stable historical fact once true, never revised on
  // a later query, the same "resolved is a one-time transition" discipline
  // AutonomousPlanEvolutionEngine already applies to PlanItemChangeType.
  supersededBy?: { planId: string; cycleNumber: number };
}

// Result of comparing a freshly computed, not-yet-recorded live
// AutonomousPlan against the currently active recorded plan. Computing this
// never records anything — it is a pure "what if" query.
export interface LivePlanComparison {
  hasActivePlan: boolean;
  // True only when hasActivePlan is true AND every item transition the
  // comparison found would be "recurring" — i.e. recording the live plan
  // right now would change nothing. False whenever there is no active plan
  // to compare against (a first cycle is always a change) or anything is
  // new/resolved/escalating.
  matchesActivePlan: boolean;
  // The evolution the live plan would have if recorded right now, computed
  // by the exact same AutonomousPlanEvolutionEngine.analyze() a real
  // recorded cycle uses — never a second, independently invented diff.
  // cycleNumber inside it is hypothetical (what the next cycle number would
  // be), never a persisted value. undefined only when hasActivePlan is
  // false — with nothing recorded yet, there is nothing to compare against.
  hypotheticalEvolution: AutonomousPlanEvolutionReport | undefined;
}
