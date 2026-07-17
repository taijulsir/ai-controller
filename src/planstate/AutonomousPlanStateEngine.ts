import type { IAutonomousPlanEvolutionEngine } from "../planhistory/interfaces";
import type { AutonomousPlanHistoryEntry } from "../planhistory/types";
import type { AutonomousPlan } from "../autonomy/types";
import type { IAutonomousPlanStateEngine } from "./interfaces";
import type { AutonomousPlanState, LivePlanComparison } from "./types";

const NEXT_HYPOTHETICAL_CYCLE_OFFSET = 1;

// Two responsibilities, both read-only derivations over already-computed
// data, never a write of any kind:
//
// deriveStates() turns the ordering AutonomousPlanHistoryService.getHistory()
// already guarantees (newest-first, strictly monotonic cycleNumber) into an
// explicit active/superseded label per entry — no new persistence, nothing
// stored, recomputed fresh from whatever window its caller passes in every
// time. This method alone needs no collaborator at all.
//
// compareToActive() composes the injected IAutonomousPlanEvolutionEngine to
// answer whether a live, not-yet-recorded plan would actually change
// anything if recorded right now — it reuses the exact same comparison
// AutonomousPlanHistoryService.record() performs at real record time, never
// a second diffing algorithm, and it never records anything itself.
//
// Kept to exactly these two derivation-over-history responsibilities by
// design: if compareToActive() ever needs to grow beyond "would recording
// this live plan change anything," that growth belongs in a dedicated
// comparison component, not here — this class stays focused on deriving
// plan state from recorded history.
export class AutonomousPlanStateEngine implements IAutonomousPlanStateEngine {
  constructor(private readonly evolutionEngine: IAutonomousPlanEvolutionEngine) {}

  // The entry at index 0 is active by definition — there is nothing newer
  // in the window. Every other entry was superseded by whichever entry
  // immediately precedes it in this same array; a truncated window (a small
  // `limit` passed to getHistory()) never mislabels an entry, since every
  // entry except the true head of all-time history has a real successor.
  deriveStates(history: AutonomousPlanHistoryEntry[]): AutonomousPlanState[] {
    return history.map((entry, index) => {
      if (index === 0) {
        return this.toState(entry, "active");
      }
      const supersedingEntry = history[index - 1];
      return this.toState(entry, "superseded", {
        planId: supersedingEntry.plan.id,
        cycleNumber: supersedingEntry.cycleNumber,
      });
    });
  }

  compareToActive(livePlan: AutonomousPlan, activeEntry: AutonomousPlanHistoryEntry | undefined): LivePlanComparison {
    if (!activeEntry) {
      return { hasActivePlan: false, matchesActivePlan: false, hypotheticalEvolution: undefined };
    }

    const hypotheticalCycleNumber = activeEntry.cycleNumber + NEXT_HYPOTHETICAL_CYCLE_OFFSET;
    const hypotheticalEvolution = this.evolutionEngine.analyze(activeEntry, livePlan, hypotheticalCycleNumber);
    const matchesActivePlan = hypotheticalEvolution.transitions.every((transition) => transition.changeType === "recurring");

    return { hasActivePlan: true, matchesActivePlan, hypotheticalEvolution };
  }

  private toState(
    entry: AutonomousPlanHistoryEntry,
    status: AutonomousPlanState["status"],
    supersededBy?: AutonomousPlanState["supersededBy"],
  ): AutonomousPlanState {
    return {
      planId: entry.plan.id,
      cycleNumber: entry.cycleNumber,
      status,
      recordedAt: entry.recordedAt,
      supersededBy,
    };
  }
}
