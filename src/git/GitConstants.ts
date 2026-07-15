export const GIT_BINARY = "git";

export const DEFAULT_RECENT_COMMITS_LIMIT = 5;

// Fields are joined with \x1f (unit separator) and each record terminated with \x1e
// (record separator) so commit subjects containing spaces/punctuation can never be
// mistaken for a field boundary — see GitLogParser.ts.
const RECENT_COMMITS_FORMAT = "%H\x1f%h\x1f%an\x1f%aI\x1f%s\x1e";

export const GitCommand = {
  status: (): string[] => ["status", "--porcelain=v2", "--branch"],
  currentBranch: (): string[] => ["rev-parse", "--abbrev-ref", "HEAD"],
  checkout: (branch: string): string[] => ["checkout", branch],
  createBranch: (branch: string): string[] => ["checkout", "-b", branch],
  stageAll: (): string[] => ["add", "-A"],
  commit: (message: string): string[] => ["commit", "-m", message],
  push: (): string[] => ["push", "--set-upstream", "origin", "HEAD"],
  pull: (): string[] => ["pull"],
  recentCommits: (limit: number): string[] => ["log", "-n", String(limit), `--pretty=tformat:${RECENT_COMMITS_FORMAT}`],
} as const;
