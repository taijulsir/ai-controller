import type { IGitAdapter } from "../../git/interfaces";
import { MissingTaskInputError } from "../errors";
import type { ITaskWorkflow } from "../interfaces";
import type { CreateBranchTask, Task, WorkflowResult } from "../types";

export class CreateBranchWorkflow implements ITaskWorkflow {
  constructor(private readonly gitAdapter: IGitAdapter) {}

  async execute(task: Task, _signal: AbortSignal): Promise<WorkflowResult> {
    const { input } = task as CreateBranchTask;
    if (!input?.branch) {
      throw new MissingTaskInputError(task.type, "branch");
    }

    // No working-tree check here, unlike SwitchBranchWorkflow: `git checkout
    // -b` creates the new branch at the current commit and moves HEAD to it
    // without changing any tracked file content, so it carries uncommitted
    // changes forward safely — there is nothing for it to conflict with.
    await this.gitAdapter.createBranch(input.branch);
    return { success: true, output: input.branch };
  }
}
