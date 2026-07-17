import type { AutonomousPlanCycleSummary } from "../plan/types";
import type { AutonomousPlanAnalysisReport } from "./types";

export interface IAutonomousPlanningAnalysisEngine {
  // cycles must be newest-first, exactly AutonomousPlanningService.getRecentCycles()'s
  // existing contract.
  analyze(cycles: AutonomousPlanCycleSummary[]): AutonomousPlanAnalysisReport;
}
