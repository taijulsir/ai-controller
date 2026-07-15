import type { RepositorySnapshot } from "./types";

export interface IRepositoryIntelligenceService {
  getSnapshot(repositoryId?: string): Promise<RepositorySnapshot>;
}
