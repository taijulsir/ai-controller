import type { IProjectMemoryService } from "../memory/interfaces";
import type { ProjectMemoryEvent } from "../memory/types";
import type { IContextBuilder } from "./interfaces";
import type { ExecutionContext, ExecutionContextRequest } from "./types";

const DEFAULT_HISTORY_LIMIT = 20;
const RELEVANT_HISTORY_LIMIT = 5;

// Assembles context from the RepositorySnapshot it's given — it no longer
// fetches one itself, same boundary as DecisionEngine. Its own responsibility
// narrows to what only it owns: filtering Project Memory history for
// relevance to a prospective task.
export class ContextBuilder implements IContextBuilder {
  constructor(private readonly projectMemory: IProjectMemoryService) {}

  async build(request: ExecutionContextRequest): Promise<ExecutionContext> {
    const warnings: string[] = [];
    const { repository } = request;

    let recentHistory: ProjectMemoryEvent[] = [];
    try {
      recentHistory = await this.projectMemory.getRecentEvents({
        repositoryId: repository.repository.id,
        limit: request.historyLimit ?? DEFAULT_HISTORY_LIMIT,
      });
    } catch (error) {
      warnings.push(`Could not read recent history: ${error instanceof Error ? error.message : String(error)}`);
    }

    const relevantHistory = request.task
      ? this.filterRelevantHistory(recentHistory, request.task.type)
      : recentHistory;

    return {
      repository,
      recentHistory,
      relevantHistory,
      activeWorkflow: request.activeWorkflow,
      task: request.task,
      generatedAt: new Date(),
      warnings,
    };
  }

  private filterRelevantHistory(events: ProjectMemoryEvent[], taskType: string): ProjectMemoryEvent[] {
    return events
      .filter(
        (event) =>
          event.outcome.kind === "result" &&
          event.outcome.result.kind === "task" &&
          event.outcome.result.taskResult.taskType === taskType,
      )
      .slice(0, RELEVANT_HISTORY_LIMIT);
  }
}
