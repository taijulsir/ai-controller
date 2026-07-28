// Pure, offline derivation of a GitHub web URL from a `git remote get-url`
// result. Deliberately never shells out to `gh` (unlike GithubAdapter, which
// needs GitHub CLI auth for PR operations) -- a push/commit summary must
// never fail or block on GitHub reachability just to show a "nice to have"
// link, and returns undefined rather than throwing whenever the remote isn't
// a recognizable github.com URL.
export interface GithubRepoSlug {
  owner: string;
  repo: string;
}

const SSH_REMOTE_PATTERN = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/;
const HTTPS_REMOTE_PATTERN = /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/;

export function parseGithubRemote(remoteUrl: string): GithubRepoSlug | undefined {
  const match = SSH_REMOTE_PATTERN.exec(remoteUrl) ?? HTTPS_REMOTE_PATTERN.exec(remoteUrl);
  if (!match) {
    return undefined;
  }
  return { owner: match[1], repo: match[2] };
}

export function buildGithubCommitUrl(remoteUrl: string, sha: string): string | undefined {
  const slug = parseGithubRemote(remoteUrl);
  return slug ? `https://github.com/${slug.owner}/${slug.repo}/commit/${sha}` : undefined;
}

export function buildGithubTreeUrl(remoteUrl: string, branch: string): string | undefined {
  const slug = parseGithubRemote(remoteUrl);
  return slug ? `https://github.com/${slug.owner}/${slug.repo}/tree/${encodeURIComponent(branch)}` : undefined;
}
