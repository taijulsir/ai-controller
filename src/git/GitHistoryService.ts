import type { IRepositoryRegistry } from "../repositories/interfaces";
import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT } from "./GitConstants";
import { GitAdapter } from "./GitAdapter";
import { BranchNotFoundError, CommitNotFoundError, GitCommandError } from "./errors";
import type { IGitHistoryService } from "./interfaces";
import type { CommitDetail, CommitDiffStatResult, GitHistoryFilter, GitHistoryResult } from "./types";

// Git History & Inspection System (/history, /show, /diff): composes
// GitAdapter's mechanical primitives into ready-to-format results, exactly
// the role GitHealthService already plays for /health -- GitAdapter itself
// still never decides what's "interesting" or translates a failure into a
// friendly message.
export class GitHistoryService implements IGitHistoryService {
  constructor(private readonly repositoryRegistry: IRepositoryRegistry) {}

  async getHistory(repositoryId: string, filter: GitHistoryFilter): Promise<GitHistoryResult> {
    const gitAdapter = new GitAdapter(this.repositoryRegistry, repositoryId);

    // Checked proactively, before ever running the log command itself --
    // git's own "unknown revision or path" stderr for a bad ref is
    // ambiguous (does it mean "no such branch" or something else?), and
    // this is the one case among the three filters that names something
    // structurally verifiable in advance.
    if (filter.branch) {
      const branches = await gitAdapter.listBranches();
      if (!branches.includes(filter.branch)) {
        throw new BranchNotFoundError(filter.branch);
      }
    }

    const limit = Math.min(filter.limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);

    const [commits, currentBranch, headSha] = await Promise.all([
      this.safeGetCommits(gitAdapter, limit, filter),
      gitAdapter.currentBranch().catch(() => ""),
      gitAdapter.headSha().catch(() => ""),
    ]);

    return { repositoryId, commits, currentBranch, headSha, detachedHead: currentBranch === "HEAD" };
  }

  async getCommitDetail(repositoryId: string, hash: string): Promise<CommitDetail> {
    const gitAdapter = new GitAdapter(this.repositoryRegistry, repositoryId);

    const metadata = await this.getCommitMetadataOrThrow(gitAdapter, hash);

    const [files, diffStats, currentBranch, headSha] = await Promise.all([
      gitAdapter.getCommitFileChanges(metadata.sha),
      gitAdapter.getCommitDiffStat(metadata.sha),
      gitAdapter.currentBranch().catch(() => ""),
      gitAdapter.headSha().catch(() => ""),
    ]);

    const isHead = headSha !== "" && headSha === metadata.sha;
    const { insertions, deletions } = this.sumDiffStats(diffStats);

    return {
      ...metadata,
      isHead,
      currentBranch: isHead && currentBranch !== "HEAD" ? currentBranch : undefined,
      files,
      filesChanged: files.length,
      insertions,
      deletions,
    };
  }

  async getCommitDiffStat(repositoryId: string, hash: string): Promise<CommitDiffStatResult> {
    const gitAdapter = new GitAdapter(this.repositoryRegistry, repositoryId);

    const metadata = await this.getCommitMetadataOrThrow(gitAdapter, hash);
    const files = await gitAdapter.getCommitDiffStat(metadata.sha);
    const { insertions, deletions } = this.sumDiffStats(files);

    return { sha: metadata.sha, shortSha: metadata.shortSha, files, filesChanged: files.length, insertions, deletions };
  }

  // A GitCommandError here always means the hash git was asked to resolve
  // doesn't exist -- getCommitMetadata's only failure mode -- so it is
  // always translated the same way, never left as raw git stderr.
  private async getCommitMetadataOrThrow(gitAdapter: GitAdapter, hash: string) {
    try {
      return await gitAdapter.getCommitMetadata(hash);
    } catch (error) {
      if (error instanceof GitCommandError) {
        throw new CommitNotFoundError(hash);
      }
      throw error;
    }
  }

  // A listing endpoint's own failure mode is different from a single-commit
  // lookup's: an empty repository, an uninitialized repository, or a
  // filter (author:/search:) that matches nothing are all indistinguishable
  // from git's own stderr without fragile message-sniffing, and an empty
  // result is the correct, honest answer to "list commits matching X" in
  // every one of those cases alike -- never a fabricated error for what is,
  // from this endpoint's perspective, simply "nothing to show."
  private async safeGetCommits(gitAdapter: GitAdapter, limit: number, filter: GitHistoryFilter) {
    try {
      return await gitAdapter.getCommitHistory(limit, filter.branch, filter.author, filter.search);
    } catch (error) {
      if (error instanceof GitCommandError) {
        return [];
      }
      throw error;
    }
  }

  private sumDiffStats(stats: { insertions: number; deletions: number }[]): { insertions: number; deletions: number } {
    return stats.reduce(
      (totals, stat) => ({ insertions: totals.insertions + stat.insertions, deletions: totals.deletions + stat.deletions }),
      { insertions: 0, deletions: 0 },
    );
  }
}
