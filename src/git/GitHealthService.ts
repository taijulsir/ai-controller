import { readFile, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import type { IOperationJournal } from "../journal/interfaces";
import { JournalEntryStatus, JournalOperationType, type JournalEntry } from "../journal/types";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import { GitAdapter } from "./GitAdapter";
import { NoActiveRepositoryError } from "./errors";
import type { IGitHealthService } from "./interfaces";
import {
  InProgressOperationKind,
  type GitLockStatus,
  type GitStatus,
  type InProgressOperation,
  type InterruptedOperationInfo,
  type LfsStatus,
  type RebaseProgress,
  type RepositoryHealthReport,
  type UpstreamStatus,
} from "./types";

// A lock file older than this is treated as abandoned rather than actively
// held -- git itself never records a PID in index.lock/HEAD.lock, so mtime
// age is the only cross-platform signal available without process
// introspection. Comfortably above any single git command's own runtime.
// Reused as the same staleness threshold for an open Operation Journal entry
// below -- both signals answer the same question ("has this looked abandoned
// for longer than any single git command should ever take").
const STALE_LOCK_THRESHOLD_MS = 5 * 60_000;

// The only JournalOperationType values with a corresponding
// InProgressOperationKind (see RepositoryStateAnalyzer's own
// IN_PROGRESS_STATE_BY_KIND) -- every other operation type is a single git
// command with no multi-step "in progress" state of its own to be
// interrupted out of.
const JOURNAL_OPERATION_TO_IN_PROGRESS_KIND: Partial<Record<JournalOperationType, InProgressOperationKind>> = {
  [JournalOperationType.Merge]: InProgressOperationKind.Merge,
  [JournalOperationType.Rebase]: InProgressOperationKind.Rebase,
};

// Known limitations (see the implementation report): branchProtection always
// undefined (no GitHub branch-protection query exists yet to call), and
// forcePushDetected/remoteChangedSinceLastFetch always false (both require
// persisting the previous remote-tracking SHA across calls, which nothing in
// this phase does). Every other field is a real, working detection.
export class GitHealthService implements IGitHealthService {
  constructor(
    private readonly repositoryRegistry: IRepositoryRegistry,
    private readonly journal: IOperationJournal,
  ) {}

  async getHealth(repositoryId?: string): Promise<RepositoryHealthReport> {
    const repository = repositoryId
      ? this.repositoryRegistry.getRepository(repositoryId)
      : this.repositoryRegistry.getActiveRepository();
    if (!repository) {
      throw new NoActiveRepositoryError();
    }

    const gitAdapter = new GitAdapter(this.repositoryRegistry, repository.id);

    const [status, branch, headSha, gitDir, isShallow, stashCount] = await Promise.all([
      gitAdapter.status(),
      gitAdapter.currentBranch(),
      gitAdapter.headSha(),
      gitAdapter.gitDir(),
      gitAdapter.isShallowRepository(),
      gitAdapter.stashCount(),
    ]);

    const detachedHead = branch === "HEAD";

    const [upstream, inProgressOperation, locks, worktrees, submodules, lfs, mostRecentJournalEntry] = await Promise.all([
      this.readUpstream(gitAdapter, status, branch, detachedHead),
      this.detectInProgressOperation(gitDir),
      this.detectLocks(gitDir),
      gitAdapter.listWorktrees(),
      this.detectSubmodules(gitAdapter, repository.path),
      this.detectLfs(repository.path),
      this.journal.getMostRecent(repository.id),
    ]);

    const interruptedOperation = this.detectInterrupted(inProgressOperation, locks, mostRecentJournalEntry);

    return {
      repositoryId: repository.id,
      capturedAt: new Date(),
      branch,
      detachedHead,
      headSha,
      upstream,
      staged: status.staged,
      unstaged: status.unstaged,
      untracked: status.untracked,
      isClean: status.isClean,
      inProgressOperation,
      stashCount,
      branchProtection: undefined,
      locks,
      worktrees,
      submodules,
      isShallow,
      lfs,
      interruptedOperation,
      forcePushDetected: false,
      remoteChangedSinceLastFetch: false,
    };
  }

  private async readUpstream(
    gitAdapter: GitAdapter,
    status: GitStatus,
    branch: string,
    detachedHead: boolean,
  ): Promise<UpstreamStatus | undefined> {
    if (detachedHead) {
      return undefined;
    }
    const configured = await gitAdapter.hasUpstreamConfigured(branch);
    if (!configured) {
      return undefined;
    }
    const ref = await gitAdapter.upstreamRef();
    if (!ref) {
      return { ref: "", ahead: 0, behind: 0, diverged: false, deleted: true };
    }
    return { ref, ahead: status.ahead, behind: status.behind, diverged: status.ahead > 0 && status.behind > 0, deleted: false };
  }

  private async detectInProgressOperation(gitDir: string): Promise<InProgressOperation | undefined> {
    if (await this.exists(path.join(gitDir, "MERGE_HEAD"))) {
      return { kind: InProgressOperationKind.Merge };
    }
    const rebaseMergeDir = path.join(gitDir, "rebase-merge");
    if (await this.exists(rebaseMergeDir)) {
      return { kind: InProgressOperationKind.Rebase, detail: await this.readRebaseMergeProgress(rebaseMergeDir) };
    }
    const rebaseApplyDir = path.join(gitDir, "rebase-apply");
    if (await this.exists(rebaseApplyDir)) {
      return { kind: InProgressOperationKind.Rebase, detail: await this.readRebaseApplyProgress(rebaseApplyDir) };
    }
    if (await this.exists(path.join(gitDir, "CHERRY_PICK_HEAD"))) {
      return { kind: InProgressOperationKind.CherryPick };
    }
    if (await this.exists(path.join(gitDir, "REVERT_HEAD"))) {
      return { kind: InProgressOperationKind.Revert };
    }
    if (await this.exists(path.join(gitDir, "BISECT_LOG"))) {
      return { kind: InProgressOperationKind.Bisect };
    }
    return undefined;
  }

  private async readRebaseMergeProgress(dir: string): Promise<RebaseProgress | undefined> {
    const currentStep = await this.readIntFile(path.join(dir, "msgnum"));
    const totalSteps = await this.readIntFile(path.join(dir, "end"));
    if (currentStep === undefined || totalSteps === undefined) {
      return undefined;
    }
    // Approximation: a stopped-sha file means the interactive/merge rebase
    // is paused for conflict resolution, not just between-commit progress.
    const conflicted = await this.exists(path.join(dir, "stopped-sha"));
    return { currentStep, totalSteps, conflicted };
  }

  private async readRebaseApplyProgress(dir: string): Promise<RebaseProgress | undefined> {
    const currentStep = await this.readIntFile(path.join(dir, "next"));
    const totalSteps = await this.readIntFile(path.join(dir, "last"));
    if (currentStep === undefined || totalSteps === undefined) {
      return undefined;
    }
    // Approximation: a leftover .patch file means `git am`-style rebase is
    // paused mid-application.
    const conflicted = await this.exists(path.join(dir, "patch"));
    return { currentStep, totalSteps, conflicted };
  }

  private async detectLocks(gitDir: string): Promise<GitLockStatus> {
    const [indexLockStat, headLockStat] = await Promise.all([
      this.statOrUndefined(path.join(gitDir, "index.lock")),
      this.statOrUndefined(path.join(gitDir, "HEAD.lock")),
    ]);
    const now = Date.now();
    const isStale = (candidate: Stats | undefined): boolean =>
      candidate !== undefined && now - candidate.mtimeMs > STALE_LOCK_THRESHOLD_MS;
    return {
      indexLocked: indexLockStat !== undefined,
      headLocked: headLockStat !== undefined,
      staleLockDetected: isStale(indexLockStat) || isStale(headLockStat),
    };
  }

  private detectInterrupted(
    inProgressOperation: InProgressOperation | undefined,
    locks: GitLockStatus,
    mostRecentJournalEntry: JournalEntry | undefined,
  ): InterruptedOperationInfo | undefined {
    if (!inProgressOperation) {
      return undefined;
    }

    const matchingEntry =
      mostRecentJournalEntry?.status === JournalEntryStatus.InProgress &&
      JOURNAL_OPERATION_TO_IN_PROGRESS_KIND[mostRecentJournalEntry.operation] === inProgressOperation.kind
        ? mostRecentJournalEntry
        : undefined;

    // A stale lock file catches a crash mid-git-command. A stale, still-open
    // Operation Journal entry for this same operation catches the more
    // common case a lock file can never see: the git command itself
    // completed (or paused for a conflict), leaving no lock behind, but the
    // controller that started it never came back to record completion or
    // roll it back -- e.g. the process was killed while a merge conflict sat
    // unresolved. Without this, that case reported a clean bill of health
    // forever, since staleLockDetected alone never fires for it.
    const journalEntryIsStale = matchingEntry !== undefined && this.isStale(matchingEntry.startedAt);
    if (!locks.staleLockDetected && !journalEntryIsStale) {
      return undefined;
    }
    return { kind: inProgressOperation.kind, journalEntryId: matchingEntry?.id };
  }

  private isStale(date: Date): boolean {
    return Date.now() - date.getTime() > STALE_LOCK_THRESHOLD_MS;
  }

  private async detectSubmodules(gitAdapter: GitAdapter, repositoryPath: string) {
    if (!(await this.exists(path.join(repositoryPath, ".gitmodules")))) {
      return [];
    }
    return gitAdapter.listSubmodules();
  }

  private async detectLfs(repositoryPath: string): Promise<LfsStatus | undefined> {
    const gitattributesPath = path.join(repositoryPath, ".gitattributes");
    if (!(await this.exists(gitattributesPath))) {
      return undefined;
    }
    const content = await readFile(gitattributesPath, "utf8").catch(() => "");
    if (!content.includes("filter=lfs")) {
      return undefined;
    }
    // Known simplification: pendingUploads/pendingDownloads are always 0.
    // Reporting `enabled: true` accurately (a real, file-based check) without
    // fabricating precise pending-transfer counts that would require parsing
    // `git lfs status --porcelain` output whose shape varies across LFS CLI
    // versions.
    return { enabled: true, cliAvailable: false, pendingUploads: 0, pendingDownloads: 0 };
  }

  private async exists(candidatePath: string): Promise<boolean> {
    return (await this.statOrUndefined(candidatePath)) !== undefined;
  }

  private async statOrUndefined(candidatePath: string): Promise<Stats | undefined> {
    try {
      return await stat(candidatePath);
    } catch {
      return undefined;
    }
  }

  private async readIntFile(candidatePath: string): Promise<number | undefined> {
    try {
      const content = await readFile(candidatePath, "utf8");
      const value = Number.parseInt(content.trim(), 10);
      return Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
}
