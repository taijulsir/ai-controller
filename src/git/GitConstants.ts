export const GIT_BINARY = "git";

export const GitCommand = {
  status: (): string[] => ["status", "--porcelain=v2", "--branch"],
  currentBranch: (): string[] => ["rev-parse", "--abbrev-ref", "HEAD"],
  checkout: (branch: string): string[] => ["checkout", branch],
  createBranch: (branch: string): string[] => ["checkout", "-b", branch],
  stageAll: (): string[] => ["add", "-A"],
  commit: (message: string): string[] => ["commit", "-m", message],
  push: (): string[] => ["push"],
  pull: (): string[] => ["pull"],
} as const;
