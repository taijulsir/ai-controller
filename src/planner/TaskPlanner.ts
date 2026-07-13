import { randomUUID } from "node:crypto";
import type { IConfigService } from "../config/interfaces";
import { TaskConcurrencyLimitExceededError, TaskTimeoutError } from "./errors";
import type { ITaskPlanner, IWorkflowFactory } from "./interfaces";
import type { Task, TaskExecutionContext, TaskResult } from "./types";

export class TaskPlanner implements ITaskPlanner {
  private runningTaskCount = 0;

  constructor(
    private readonly configService: IConfigService,
    private readonly workflowFactory: IWorkflowFactory,
  ) {}

  async run(task: Task, context: TaskExecutionContext = {}): Promise<TaskResult> {
    const correlationId = context.correlationId ?? randomUUID();
    const controllerConfig = this.configService.getControllerConfig();

    if (this.runningTaskCount >= controllerConfig.task.max_concurrent_jobs) {
      throw new TaskConcurrencyLimitExceededError(controllerConfig.task.max_concurrent_jobs);
    }

    const workflow = this.workflowFactory.create(task, context);
    this.runningTaskCount++;

    const abortController = new AbortController();
    const timeoutMinutes = controllerConfig.task.timeout_minutes;
    const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMinutes * 60_000);

    try {
      const result = await Promise.race([
        workflow.execute(task, abortController.signal),
        this.rejectOnAbort(abortController.signal, task, timeoutMinutes),
      ]);
      return { ...result, taskType: task.type, repositoryId: context.repositoryId, correlationId };
    } catch (error) {
      return {
        success: false,
        taskType: task.type,
        error: error instanceof Error ? error.message : String(error),
        repositoryId: context.repositoryId,
        correlationId,
      };
    } finally {
      clearTimeout(timeoutHandle);
      this.runningTaskCount--;
    }
  }

  private rejectOnAbort(signal: AbortSignal, task: Task, timeoutMinutes: number): Promise<never> {
    return new Promise((_, reject) => {
      const onAbort = () => reject(new TaskTimeoutError(task.type, timeoutMinutes));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
