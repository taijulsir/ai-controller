import { randomUUID } from "node:crypto";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import type { ITaskPlanner } from "../planner/interfaces";
import type { TaskExecutionContext } from "../planner/types";
import type { IControllerCore } from "./interfaces";
import type { ExecutionRequest, ExecutionResult } from "./types";

export class ControllerCore implements IControllerCore {
  constructor(
    private readonly repositoryRegistry: IRepositoryRegistry,
    private readonly taskPlanner: ITaskPlanner,
  ) {}

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const repository = request.repositoryId
      ? this.repositoryRegistry.getRepository(request.repositoryId)
      : this.repositoryRegistry.getActiveRepository();

    if (!repository) {
      throw new Error("No repository specified and no active repository is set.");
    }

    const context: TaskExecutionContext = {
      repositoryId: repository.id,
      correlationId: request.correlationId ?? randomUUID(),
    };

    const startedAt = new Date();
    const taskResult = await this.taskPlanner.run(request.task, context);
    const completedAt = new Date();

    return {
      taskResult,
      startedAt,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
    };
  }
}
