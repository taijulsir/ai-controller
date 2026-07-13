import type { IGitAdapter } from "../../git/interfaces";
import type { ITaskWorkflow } from "../interfaces";
import type { Task, WorkflowResult } from "../types";

export class PushChangesWorkflow implements ITaskWorkflow {
  constructor(private readonly gitAdapter: IGitAdapter) {}

  async execute(_task: Task, _signal: AbortSignal): Promise<WorkflowResult> {
    await this.gitAdapter.push();
    return { success: true };
  }
}
