import type { RepositoryInsightReport } from "../decisions/types";
import type { RepositorySnapshot } from "../intelligence/types";
import type { ProjectMemoryEvent } from "../memory/types";
import type { ClaudeSessionInfo } from "../session/types";

export interface IApplicationService {
  getRepositoryStatus(repositoryId?: string): Promise<RepositorySnapshot>;
  getRepositoryHistory(repositoryId?: string, limit?: number): Promise<ProjectMemoryEvent[]>;
  getRepositoryInsights(repositoryId?: string): Promise<RepositoryInsightReport>;
  getSessionStatus(repositoryId?: string): ClaudeSessionInfo | undefined;
}
