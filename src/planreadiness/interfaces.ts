import type { AutonomousPlanAnalysisReport } from "../plananalysis/types";
import type { AutonomousPlanningSnapshot } from "../plan/types";
import type { AutonomousPlanReadinessReport } from "./types";

export interface IAutonomousPlanReadinessEngine {
  assess(snapshot: AutonomousPlanningSnapshot, analysis: AutonomousPlanAnalysisReport): AutonomousPlanReadinessReport;
}
