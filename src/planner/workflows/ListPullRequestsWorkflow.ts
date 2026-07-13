import type { IGithubAdapter } from "../../github/interfaces";
import type { ITaskWorkflow } from "../interfaces";
import type { Task, WorkflowResult } from "../types";

export class ListPullRequestsWorkflow implements ITaskWorkflow {
  constructor(private readonly githubAdapter: IGithubAdapter) {}

  async execute(_task: Task, _signal: AbortSignal): Promise<WorkflowResult> {
    const pullRequests = await this.githubAdapter.listOpenPullRequests();
    if (pullRequests.length === 0) {
      return { success: true, output: "No open pull requests." };
    }

    const lines = pullRequests.map(
      (pr) => `#${pr.number} ${pr.title} (${pr.headBranch} → ${pr.baseBranch}) — ${pr.url}`,
    );
    return { success: true, output: lines.join("\n") };
  }
}
