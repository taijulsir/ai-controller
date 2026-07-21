import type { IGitAdapter } from "../../git/interfaces";
import { MissingTaskInputError, UnsafeBranchSwitchError } from "../errors";
import type { ITaskWorkflow } from "../interfaces";
import type { SwitchBranchTask, Task, WorkflowResult } from "../types";

export class SwitchBranchWorkflow implements ITaskWorkflow {
  constructor(private readonly gitAdapter: IGitAdapter) {}

  async execute(task: Task, _signal: AbortSignal): Promise<WorkflowResult> {
    const { input } = task as SwitchBranchTask;
    if (!input?.branch) {
      throw new MissingTaskInputError(task.type, "branch");
    }

    // Reuses the same GitStatus.isClean signal GitStatusWorkflow already
    // reports, rather than inventing new validation. A plain (non -f) `git
    // checkout` already refuses a switch that would overwrite conflicting
    // uncommitted changes on its own, but checking first avoids even
    // attempting one and gives a clearer message than raw git stderr would.
    // Thrown, not returned as { success: false }, matching
    // MissingTaskInputError's convention — TaskPlanner.run()'s catch is the
    // one place that shapes a thrown error into a failed TaskResult.
    const status = await this.gitAdapter.status();
    if (!status.isClean) {
      throw new UnsafeBranchSwitchError(input.branch, status.staged.length, status.unstaged.length, status.untracked.length);
    }

    await this.gitAdapter.checkout(input.branch);
    return { success: true, output: input.branch };
  }
}
