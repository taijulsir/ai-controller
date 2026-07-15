import type { IDecisionEngine } from "../decisions/interfaces";
import type { RepositoryInsightReport } from "../decisions/types";
import type { IRepositoryIntelligenceService } from "../intelligence/interfaces";
import type { RepositorySnapshot } from "../intelligence/types";
import type { IProjectMemoryService } from "../memory/interfaces";
import type { ProjectMemoryEvent } from "../memory/types";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import type { IClaudeSessionManager } from "../session/interfaces";
import type { ClaudeSessionInfo } from "../session/types";
import { NoActiveRepositoryError } from "./errors";
import type { IApplicationService } from "./interfaces";

export class ApplicationService implements IApplicationService {
  constructor(
    private readonly repositoryIntelligence: IRepositoryIntelligenceService,
    private readonly projectMemory: IProjectMemoryService,
    private readonly decisionEngine: IDecisionEngine,
    private readonly sessionManager: IClaudeSessionManager,
    private readonly repositoryRegistry: IRepositoryRegistry,
  ) {}

  async getRepositoryStatus(repositoryId?: string): Promise<RepositorySnapshot> {
    return this.repositoryIntelligence.getSnapshot(this.resolveRepositoryId(repositoryId));
  }

  async getRepositoryHistory(repositoryId?: string, limit?: number): Promise<ProjectMemoryEvent[]> {
    return this.projectMemory.getRecentEvents({ repositoryId: this.resolveRepositoryId(repositoryId), limit });
  }

  async getRepositoryInsights(repositoryId?: string): Promise<RepositoryInsightReport> {
    return this.decisionEngine.analyze(this.resolveRepositoryId(repositoryId));
  }

  getSessionStatus(repositoryId?: string): ClaudeSessionInfo | undefined {
    return this.sessionManager.getSessionStatus(this.resolveRepositoryId(repositoryId));
  }

  private resolveRepositoryId(repositoryId?: string): string {
    if (repositoryId) {
      return repositoryId;
    }
    const activeRepository = this.repositoryRegistry.getActiveRepository();
    if (!activeRepository) {
      throw new NoActiveRepositoryError();
    }
    return activeRepository.id;
  }
}
