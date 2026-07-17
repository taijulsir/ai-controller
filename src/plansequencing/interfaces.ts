import type { AutonomousPlanReadinessReport } from "../planreadiness/types";
import type { AutonomousPlanSequencingReport } from "./types";

export interface IAutonomousPlanSequencingEngine {
  sequence(readiness: AutonomousPlanReadinessReport): AutonomousPlanSequencingReport;
}
