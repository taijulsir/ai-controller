import type { PullRequestSummary } from "./types";

interface RawPullRequest {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName: string;
  author: { login: string };
}

export class PullRequestMapper {
  toDomain(rawJson: string): PullRequestSummary {
    return this.map(JSON.parse(rawJson) as RawPullRequest);
  }

  toDomainList(rawJson: string): PullRequestSummary[] {
    const rawList = JSON.parse(rawJson) as RawPullRequest[];
    return rawList.map((raw) => this.map(raw));
  }

  private map(raw: RawPullRequest): PullRequestSummary {
    return {
      number: raw.number,
      title: raw.title,
      url: raw.url,
      headBranch: raw.headRefName,
      baseBranch: raw.baseRefName,
      author: raw.author.login,
    };
  }
}
