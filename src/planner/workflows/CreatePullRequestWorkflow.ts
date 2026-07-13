import type { IGitAdapter } from "../../git/interfaces";
import type { IGithubAdapter } from "../../github/interfaces";
import { MissingTaskInputError, PullRequestBaseBranchConflictError } from "../errors";
import type { ITaskWorkflow } from "../interfaces";
import type { CreatePullRequestTask, Task, WorkflowResult } from "../types";

export class CreatePullRequestWorkflow implements ITaskWorkflow {
  constructor(
    private readonly gitAdapter: IGitAdapter,
    private readonly githubAdapter: IGithubAdapter,
  ) {}

  async execute(task: Task, _signal: AbortSignal): Promise<WorkflowResult> {
    const { input } = task as CreatePullRequestTask;
    if (!input?.title) {
      throw new MissingTaskInputError(task.type, "title");
    }

    const baseBranch = input.baseBranch ?? this.githubAdapter.getDefaultBaseBranch();
    const currentBranch = await this.gitAdapter.currentBranch();
    if (currentBranch === baseBranch) {
      throw new PullRequestBaseBranchConflictError(currentBranch);
    }

    const pullRequest = await this.githubAdapter.createPullRequest(input);
    return { success: true, output: `Pull request #${pullRequest.number} created: ${pullRequest.url}` };
  }
}
