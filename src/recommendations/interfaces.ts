import type { RepositoryInsightReport } from "../decisions/types";
import type { RepositorySnapshot } from "../intelligence/types";
import type { ClaudeSessionInfo } from "../session/types";
import type { RepositoryRecommendationReport } from "./types";

export interface IRecommendationEngine {
  recommend(
    snapshot: RepositorySnapshot,
    insightReport: RepositoryInsightReport,
    session: ClaudeSessionInfo | undefined,
  ): RepositoryRecommendationReport;
}
