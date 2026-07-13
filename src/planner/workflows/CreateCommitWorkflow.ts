import type { IGitAdapter } from "../../git/interfaces";
import { MissingTaskInputError } from "../errors";
import type { ITaskWorkflow } from "../interfaces";
import type { CreateCommitTask, Task, WorkflowResult } from "../types";

export class CreateCommitWorkflow implements ITaskWorkflow {
  constructor(private readonly gitAdapter: IGitAdapter) {}

  async execute(task: Task, _signal: AbortSignal): Promise<WorkflowResult> {
    const { input } = task as CreateCommitTask;
    if (!input?.message) {
      throw new MissingTaskInputError(task.type, "message");
    }

    await this.gitAdapter.stageAll();
    await this.gitAdapter.commit(input.message);
    return { success: true };
  }
}
