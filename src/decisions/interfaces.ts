import type { RepositoryInsightReport } from "./types";

export interface IDecisionEngine {
  analyze(repositoryId: string): Promise<RepositoryInsightReport>;
}
