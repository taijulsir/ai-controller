import { ApprovalPolicy } from "../approval/ApprovalPolicy";
import type { IApprovalPolicy } from "../approval/interfaces";
import type { IConfigService } from "../config/interfaces";
import type { Repository } from "../domain/repository/Repository";
import { GitAdapter } from "../git/GitAdapter";
import type { CommitSummary, GitStatus } from "../git/types";
import { GithubAdapter } from "../github/GithubAdapter";
import type { PullRequestSummary } from "../github/types";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import { NoActiveRepositoryError } from "./errors";
import type { IRepositoryIntelligenceService } from "./interfaces";
import type { RepositoryHealth, RepositorySnapshot, WorkflowReadiness } from "./types";

// Kept internal for now; promote to controller.yaml if a future frontend needs it configurable.
const RECENT_COMMITS_LIMIT = 5;

export class RepositoryIntelligenceService implements IRepositoryIntelligenceService {
  constructor(
    private readonly repositoryRegistry: IRepositoryRegistry,
    private readonly configService: IConfigService,
    private readonly approvalPolicy: IApprovalPolicy = new ApprovalPolicy(),
  ) {}

  async getSnapshot(repositoryId?: string): Promise<RepositorySnapshot> {
    const repository = this.resolveRepository(repositoryId);
    const gitAdapter = new GitAdapter(this.repositoryRegistry, repository.id);
    const githubAdapter = new GithubAdapter(this.configService, this.repositoryRegistry, repository.id);

    const [statusResult, commitsResult, pullRequestsResult] = await Promise.allSettled([
      gitAdapter.status(),
      gitAdapter.getRecentCommits(RECENT_COMMITS_LIMIT),
      githubAdapter.listOpenPullRequests(),
    ]);

    const issues: string[] = [];

    const isGitRepository = statusResult.status === "fulfilled";
    if (statusResult.status === "rejected") {
      issues.push(`Could not read git status: ${this.describeFailure(statusResult.reason)}`);
    }
    const status: GitStatus | undefined = statusResult.status === "fulfilled" ? statusResult.value : undefined;

    if (commitsResult.status === "rejected") {
      issues.push(`Could not read recent commits: ${this.describeFailure(commitsResult.reason)}`);
    }
    const recentCommits: CommitSummary[] = commitsResult.status === "fulfilled" ? commitsResult.value : [];

    if (pullRequestsResult.status === "rejected") {
      issues.push(`Could not reach GitHub: ${this.describeFailure(pullRequestsResult.reason)}`);
    }
    const openPullRequests: PullRequestSummary[] =
      pullRequestsResult.status === "fulfilled" ? pullRequestsResult.value : [];

    if (status && !status.isClean) {
      const parts: string[] = [];
      if (status.staged.length > 0) parts.push(`${status.staged.length} staged`);
      if (status.unstaged.length > 0) parts.push(`${status.unstaged.length} unstaged`);
      if (status.untracked.length > 0) parts.push(`${status.untracked.length} untracked`);
      issues.push(`Working tree is dirty: ${parts.join(", ")}`);
    }
    if (status && status.behind > 0) {
      issues.push(`${status.behind} commit(s) behind the remote`);
    }

    const health: RepositoryHealth = {
      isGitRepository,
      isClean: status?.isClean ?? false,
      hasUnpushedCommits: (status?.ahead ?? 0) > 0,
      isBehindRemote: (status?.behind ?? 0) > 0,
      hasOpenPullRequests: openPullRequests.length > 0,
      issues,
    };

    return {
      repository: {
        id: repository.id,
        name: repository.name,
        path: repository.path,
        defaultBranch: repository.defaultBranch,
        active: repository.active,
      },
      branch: {
        current: status?.branch ?? "unknown",
        default: repository.defaultBranch,
        ahead: status?.ahead ?? 0,
        behind: status?.behind ?? 0,
      },
      workingTree: {
        isClean: status?.isClean ?? false,
        staged: status?.staged ?? [],
        unstaged: status?.unstaged ?? [],
        untracked: status?.untracked ?? [],
      },
      recentCommits,
      pullRequests: {
        open: openPullRequests,
        openCount: openPullRequests.length,
      },
      health,
      workflowReadiness: this.buildWorkflowReadiness(health, isGitRepository),
      generatedAt: new Date(),
    };
  }

  private buildWorkflowReadiness(health: RepositoryHealth, isGitRepository: boolean): WorkflowReadiness {
    const controllerConfig = this.configService.getControllerConfig();
    const requiresApprovalBeforePush = this.approvalPolicy.requiresApproval(
      { type: "push-changes" },
      controllerConfig,
    );
    const requiresApprovalBeforePullRequest = this.approvalPolicy.requiresApproval(
      { type: "create-pull-request", input: { title: "" } },
      controllerConfig,
    );

    const blockers: string[] = [];
    if (!isGitRepository) {
      blockers.push("Repository path is not a valid git repository.");
    } else if (health.isClean && !health.hasUnpushedCommits) {
      blockers.push("No changes to ship: working tree is clean and there are no unpushed commits.");
    }

    return {
      canShip: blockers.length === 0,
      requiresApprovalBeforePush,
      requiresApprovalBeforePullRequest,
      blockers,
    };
  }

  private resolveRepository(repositoryId?: string): Repository {
    if (repositoryId) {
      return this.repositoryRegistry.getRepository(repositoryId);
    }

    const activeRepository = this.repositoryRegistry.getActiveRepository();
    if (!activeRepository) {
      throw new NoActiveRepositoryError();
    }
    return activeRepository;
  }

  private describeFailure(reason: unknown): string {
    return reason instanceof Error ? reason.message : String(reason);
  }
}
