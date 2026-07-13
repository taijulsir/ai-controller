import type { CreatePullRequestOptions, PullRequestSummary } from "./types";

export interface IGithubAdapter {
  createPullRequest(options: CreatePullRequestOptions): Promise<PullRequestSummary>;
  listOpenPullRequests(): Promise<PullRequestSummary[]>;
  getDefaultBaseBranch(): string;
}
