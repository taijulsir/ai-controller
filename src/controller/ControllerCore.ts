import { randomUUID } from "node:crypto";
import type { ITaskPlanner } from "../planner/interfaces";
import type { TaskExecutionContext } from "../planner/types";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import type { IControllerCore, IWorkflowOrchestrator } from "./interfaces";
import type { ExecutionRequest, ExecutionResult } from "./types";

export class ControllerCore implements IControllerCore {
  constructor(
    private readonly repositoryRegistry: IRepositoryRegistry,
    private readonly taskPlanner: ITaskPlanner,
    private readonly workflowOrchestrator: IWorkflowOrchestrator,
  ) {}

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const repository = request.repositoryId
      ? this.repositoryRegistry.getRepository(request.repositoryId)
      : this.repositoryRegistry.getActiveRepository();

    if (!repository) {
      throw new Error("No repository specified and no active repository is set.");
    }

    const correlationId = request.correlationId ?? randomUUID();
    const startedAt = new Date();

    if (request.kind === "workflow") {
      const workflowResult = await this.workflowOrchestrator.run({
        workflowId: request.workflowId,
        repositoryId: repository.id,
        input: request.input ?? {},
        correlationId,
      });
      const completedAt = new Date();
      return {
        kind: "workflow",
        workflowResult,
        startedAt,
        completedAt,
        durationMs: completedAt.getTime() - startedAt.getTime(),
      };
    }

    const context: TaskExecutionContext = { repositoryId: repository.id, correlationId };
    const taskResult = await this.taskPlanner.run(request.task, context);
    const completedAt = new Date();

    return {
      kind: "task",
      taskResult,
      startedAt,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
    };
  }
}
