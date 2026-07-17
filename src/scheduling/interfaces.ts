import type { AutonomousPlanSequencingReport } from "../plansequencing/types";
import type { AutonomousPlanSchedulingReport } from "./types";

export interface IAutonomousPlanSchedulingEngine {
  schedule(sequence: AutonomousPlanSequencingReport): AutonomousPlanSchedulingReport;
}
