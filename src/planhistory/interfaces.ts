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
  // The one place a planning cycle is recorded. As of Phase 10, its one
  // caller is AutonomousPlanRecordingService (src/planrecording), itself
  // reached only via ApplicationService.recordAutonomousPlanCycle() — no
  // read-facing code (AutonomousPlanningService, ApplicationService's own
  // get*() methods) calls it directly, and nothing in this codebase invokes
  // recordAutonomousPlanCycle() automatically yet. Deciding when a cycle
  // should actually be recorded on an ongoing basis remains a future
  // runtime/scheduler phase's decision — Phase 10 only made the capability
  // explicit and callable.
  record(plan: AutonomousPlan): Promise<AutonomousPlanHistoryEntry>;
  getLatestEntry(): Promise<AutonomousPlanHistoryEntry | undefined>;
  getHistory(limit?: number): Promise<AutonomousPlanHistoryEntry[]>;
}
