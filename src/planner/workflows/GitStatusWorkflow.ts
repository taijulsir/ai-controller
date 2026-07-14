import type { IGitAdapter } from "../../git/interfaces";
import type { ITaskWorkflow } from "../interfaces";
import type { Task, WorkflowResult } from "../types";

export class GitStatusWorkflow implements ITaskWorkflow {
  constructor(private readonly gitAdapter: IGitAdapter) {}

  async execute(_task: Task, _signal: AbortSignal): Promise<WorkflowResult> {
    const status = await this.gitAdapter.status();
    const summary = status.isClean
      ? `Branch "${status.branch}" is clean (ahead ${status.ahead}, behind ${status.behind}).`
      : `Branch "${status.branch}": ${status.staged.length} staged, ${status.unstaged.length} unstaged, ` +
        `${status.untracked.length} untracked (ahead ${status.ahead}, behind ${status.behind}).`;

    return { success: true, output: summary };
  }
}
