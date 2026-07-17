import type { AutonomousPlan } from "../autonomy/types";
import type { AutonomousPlanHistoryEntry } from "../planhistory/types";
import type { AutonomousPlanState, LivePlanComparison } from "./types";

export interface IAutonomousPlanStateEngine {
  // history must be newest-first, exactly AutonomousPlanHistoryService.getHistory()'s
  // existing contract.
  deriveStates(history: AutonomousPlanHistoryEntry[]): AutonomousPlanState[];
  compareToActive(
    livePlan: AutonomousPlan,
    activeEntry: AutonomousPlanHistoryEntry | undefined,
  ): LivePlanComparison;
}
