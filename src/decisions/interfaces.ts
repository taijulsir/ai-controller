import type { RepositorySnapshot } from "../intelligence/types";
import type { RepositoryInsightReport } from "./types";

export interface IDecisionEngine {
  analyze(repository: RepositorySnapshot): Promise<RepositoryInsightReport>;
}
