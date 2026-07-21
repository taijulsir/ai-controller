import type { IGitAdapter } from "../../git/interfaces";
import type { ITaskWorkflow } from "../interfaces";
import type { Task, WorkflowResult } from "../types";

// The only one of the three new Git Operations workflows with no safety
// precondition at all: fetch only updates remote-tracking refs
// (e.g. origin/main), never the working tree, the index, or the current
// branch -- there is nothing here for a dirty tree or detached HEAD to put
// at risk.
export class FetchWorkflow implements ITaskWorkflow {
  constructor(private readonly gitAdapter: IGitAdapter) {}

  async execute(_task: Task, _signal: AbortSignal): Promise<WorkflowResult> {
    await this.gitAdapter.fetch();
    const status = await this.gitAdapter.status();
    return { success: true, output: `Fetched. "${status.branch}" is now ${status.ahead} ahead, ${status.behind} behind its upstream.` };
  }
}
