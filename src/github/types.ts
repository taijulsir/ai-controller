export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  headBranch: string;
  baseBranch: string;
  author: string;
}

export interface CreatePullRequestOptions {
  title: string;
  body?: string;
  baseBranch?: string;
}
