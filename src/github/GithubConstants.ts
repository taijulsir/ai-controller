const PULL_REQUEST_JSON_FIELDS = "number,title,url,headRefName,baseRefName,author";

export const GithubCommand = {
  createPullRequest: (title: string, baseBranch: string, body?: string): string[] => [
    "pr",
    "create",
    "--title",
    title,
    "--base",
    baseBranch,
    "--body",
    body ?? "",
  ],
  viewCurrentPullRequest: (): string[] => ["pr", "view", "--json", PULL_REQUEST_JSON_FIELDS],
  listOpenPullRequests: (): string[] => ["pr", "list", "--state", "open", "--json", PULL_REQUEST_JSON_FIELDS],
} as const;
