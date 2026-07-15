import type { RepositoryAssistanceReport } from "../assistance/types";
import type { RepositoryInsightReport } from "../decisions/types";
import type { RepositorySnapshot } from "../intelligence/types";
import type { ProjectMemoryEvent } from "../memory/types";
import type { RepositoryRecommendationReport } from "../recommendations/types";
import type { ClaudeSessionInfo } from "../session/types";
import type { EngineeringWorkspace } from "../workspace/types";

export interface IApplicationService {
  getRepositoryStatus(repositoryId?: string): Promise<RepositorySnapshot>;
  getRepositoryHistory(repositoryId?: string, limit?: number): Promise<ProjectMemoryEvent[]>;
  getRepositoryInsights(repositoryId?: string): Promise<RepositoryInsightReport>;
  getSessionStatus(repositoryId?: string): ClaudeSessionInfo | undefined;
  getRecommendations(repositoryId?: string): Promise<RepositoryRecommendationReport>;
  getEngineeringAssistance(repositoryId?: string): Promise<RepositoryAssistanceReport>;
  getEngineeringWorkspace(repositoryId?: string): Promise<EngineeringWorkspace>;
}
