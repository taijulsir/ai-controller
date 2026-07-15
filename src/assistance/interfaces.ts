import type { RepositoryRecommendationReport } from "../recommendations/types";
import type { RepositoryAssistanceReport } from "./types";

export interface IEngineeringAssistanceEngine {
  propose(report: RepositoryRecommendationReport): RepositoryAssistanceReport;
}
