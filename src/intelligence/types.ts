import type { CommitSummary } from "../git/types";
import type { PullRequestSummary } from "../github/types";

export interface RepositorySnapshot {
  repository: {
    id: string;
    name: string;
    path: string;
    defaultBranch: string;
    active: boolean;
  };
  branch: {
    current: string;
    default: string;
    ahead: number;
    behind: number;
  };
  workingTree: {
    isClean: boolean;
    staged: string[];
    unstaged: string[];
    untracked: string[];
  };
  recentCommits: CommitSummary[];
  pullRequests: {
    open: PullRequestSummary[];
    openCount: number;
  };
  health: RepositoryHealth;
  workflowReadiness: WorkflowReadiness;
  generatedAt: Date;
}

export interface RepositoryHealth {
  isGitRepository: boolean;
  isClean: boolean;
  hasUnpushedCommits: boolean;
  isBehindRemote: boolean;
  hasOpenPullRequests: boolean;
  issues: string[];
}

export interface WorkflowReadiness {
  canShip: boolean;
  requiresApprovalBeforePush: boolean;
  requiresApprovalBeforePullRequest: boolean;
  blockers: string[];
}
