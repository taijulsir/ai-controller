import type { AutonomousPlan } from "../autonomy/types";
import type { AutonomousPlanEvolutionReport, AutonomousPlanHistoryEntry } from "./types";

export interface IAutonomousPlanEvolutionEngine {
  analyze(
    previous: AutonomousPlanHistoryEntry | undefined,
    currentPlan: AutonomousPlan,
    cycleNumber: number,
  ): AutonomousPlanEvolutionReport;
}

export interface IAutonomousPlanHistoryService {
  // The one place a planning cycle is recorded. Nothing in this phase calls
  // it — it exists, fully implemented and independently testable, for a
  // future runtime/scheduler phase to decide when a cycle should actually be
  // recorded. That decision is explicitly out of scope here.
  record(plan: AutonomousPlan): Promise<AutonomousPlanHistoryEntry>;
  getLatestEntry(): Promise<AutonomousPlanHistoryEntry | undefined>;
  getHistory(limit?: number): Promise<AutonomousPlanHistoryEntry[]>;
}
