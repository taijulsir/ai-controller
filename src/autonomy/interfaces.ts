import type { RepositoryRecommendationReport } from "../recommendations/types";
import type { AutonomousPlan } from "./types";

export interface IAutonomousPlanningEngine {
  buildPlan(reports: RepositoryRecommendationReport[]): AutonomousPlan;
}
