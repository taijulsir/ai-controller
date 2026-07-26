import { randomUUID } from "node:crypto";
import type { IExecutionStateReader } from "../executionstate/interfaces";
import type { IGitTransactionManager } from "../gittransaction/interfaces";
import { JournalOperationType } from "../journal/types";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import { GitAdapter } from "./GitAdapter";
import { CannotExecuteDiscardPlanError, WorkingTreeChangeNotFoundError } from "./errors";
import type { IGitHealthService, IWorkingTreeService } from "./interfaces";
import type {
  DiscardOutcome,
  DiscardPlan,
  DiscardTarget,
  WorkingTreeChange,
  WorkingTreeChangeDiff,
  WorkingTreeChangesResult,
} from "./types";

// Working Tree Management (/changes, /showchanges, /discard <index>,
// /discard all). Same role GitHistoryService plays for /history/show/diff:
// GitAdapter still never decides which files are "interesting" or which
// discard mechanism applies -- that judgment lives here. Reuses
// GitTransactionManager for discard (rollbackStrategy "restore-tree",
// exactly the mechanism DiscardWorkflow's own bare /discard already uses --
// see that class's own doc comment), so a discard performed through this
// service is reversible via /undo confirm the same way /discard already is.
// executionStateReader/gitHealthService are the same two safety checks
// UndoService.buildUndoPlan()/PreflightValidationPolicy already perform
// (never touch files mid-Claude-execution; never mutate the working tree
// while a merge/rebase/etc. is in progress) -- reused here, not
// re-implemented.
export class WorkingTreeService implements IWorkingTreeService {
  constructor(
    private readonly repositoryRegistry: IRepositoryRegistry,
    private readonly transactionManager: IGitTransactionManager,
    private readonly executionStateReader: IExecutionStateReader,
    private readonly gitHealthService: IGitHealthService,
  ) {}

  async getChanges(repositoryId: string): Promise<WorkingTreeChangesResult> {
    const gitAdapter = new GitAdapter(this.repositoryRegistry, repositoryId);
    const changes = await gitAdapter.getWorkingTreeChanges();
    return { repositoryId, ...this.summarize(changes), isClean: changes.length === 0 };
  }

  async getChangeDiff(repositoryId: string, index: number): Promise<WorkingTreeChangeDiff> {
    const gitAdapter = new GitAdapter(this.repositoryRegistry, repositoryId);
    const change = await this.resolveChange(gitAdapter, index);
    const diff = await gitAdapter.getWorkingTreeChangeDiff(change);
    return { change, diff };
  }

  async buildDiscardPlan(repositoryId: string, target: DiscardTarget): Promise<DiscardPlan> {
    // Never discard while something is actively running for this
    // repository -- the same reasoning UndoService.buildUndoPlan() already
    // documents for its own identical check: touching files git currently
    // thinks Claude itself is mid-write to would be actively dangerous, not
    // just imprecise.
    if (this.executionStateReader.getCurrent(repositoryId)) {
      return this.emptyPlan(repositoryId, target, "execution-in-progress");
    }

    // Never discard while a merge/rebase/cherry-pick/revert/bisect is in
    // progress -- the same guard PreflightValidationPolicy already applies
    // to every other mutating git command, reused here via the same
    // GitHealthService report /health itself renders (this is also the only
    // time an unmerged/conflicted path can exist, so this one check covers
    // that case too -- see parseWorkingTreeChanges's own doc comment on "u "
    // entries).
    const health = await this.gitHealthService.getHealth(repositoryId);
    if (health.inProgressOperation) {
      return this.emptyPlan(repositoryId, target, "operation-in-progress");
    }

    const gitAdapter = new GitAdapter(this.repositoryRegistry, repositoryId);
    const allChanges = await gitAdapter.getWorkingTreeChanges();

    const selected = target.kind === "all" ? allChanges : [this.findOrThrow(allChanges, target.index)];

    if (selected.length === 0) {
      return this.emptyPlan(repositoryId, target, "nothing-to-discard");
    }

    return { status: "ready", repositoryId, target, ...this.summarize(selected) };
  }

  async executeDiscardPlan(plan: DiscardPlan): Promise<DiscardOutcome> {
    if (plan.status !== "ready") {
      throw new CannotExecuteDiscardPlanError(plan.status);
    }

    const gitAdapter = new GitAdapter(this.repositoryRegistry, plan.repositoryId);
    const transaction = await this.transactionManager.begin({
      operation: JournalOperationType.Discard,
      repositoryId: plan.repositoryId,
      correlationId: randomUUID(),
      rollbackStrategy: "restore-tree",
    });

    try {
      const { restoreFromHead, unstage, remove } = this.classifyForDiscard(plan.changes);
      // Order matters: unstage before remove, so a staged-added/renamed-new
      // path is still known to git (and therefore restorable via /undo
      // confirm's own drift-checked restore-tree path) at the moment it's
      // unstaged, never removed first and unstaged second.
      await gitAdapter.restoreFromHead(restoreFromHead);
      await gitAdapter.unstagePaths(unstage);
      await gitAdapter.removeUntrackedPaths(remove);
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
    await transaction.commit(await gitAdapter.headSha());

    const remaining = await gitAdapter.getWorkingTreeChanges();
    return {
      kind: "discarded",
      affectedFiles: plan.changes.map((change) => change.path),
      ...this.summarize(remaining),
      isClean: remaining.length === 0,
    };
  }

  // Per-file dispatch: which of GitAdapter's three safe primitives applies
  // to a given change, based purely on its own status/staged/unstaged flags
  // -- never reset --hard, matching this feature's own safety requirement
  // (see GitConstants.restoreFromHead/unstagePaths/removeUntrackedPaths for
  // why each is safe on its own).
  private classifyForDiscard(changes: WorkingTreeChange[]): { restoreFromHead: string[]; unstage: string[]; remove: string[] } {
    const restoreFromHead: string[] = [];
    const unstage: string[] = [];
    const remove: string[] = [];

    for (const change of changes) {
      switch (change.status) {
        case "modified":
        case "deleted":
          restoreFromHead.push(change.path);
          break;
        case "added":
          // Always staged by definition (an "added" index status only
          // exists once a path has been `git add`ed -- an unstaged new file
          // is classified "untracked" instead, see parseWorkingTreeChanges).
          unstage.push(change.path);
          remove.push(change.path);
          break;
        case "untracked":
          remove.push(change.path);
          break;
        case "renamed":
          // The old path always exists in HEAD -- restoring it there is
          // always correct regardless of the rename's own staged state.
          restoreFromHead.push(change.renamedFrom!);
          if (change.staged) {
            unstage.push(change.path);
          }
          remove.push(change.path);
          break;
      }
    }

    return { restoreFromHead, unstage, remove };
  }

  private async resolveChange(gitAdapter: GitAdapter, index: number): Promise<WorkingTreeChange> {
    const changes = await gitAdapter.getWorkingTreeChanges();
    return this.findOrThrow(changes, index);
  }

  private findOrThrow(changes: WorkingTreeChange[], index: number): WorkingTreeChange {
    const change = changes.find((candidate) => candidate.index === index);
    if (!change) {
      throw new WorkingTreeChangeNotFoundError(index);
    }
    return change;
  }

  private summarize(changes: WorkingTreeChange[]): {
    changes: WorkingTreeChange[];
    stagedCount: number;
    unstagedCount: number;
    untrackedCount: number;
  } {
    return {
      changes,
      stagedCount: changes.filter((change) => change.staged).length,
      unstagedCount: changes.filter((change) => change.unstaged).length,
      untrackedCount: changes.filter((change) => change.status === "untracked").length,
    };
  }

  private emptyPlan(repositoryId: string, target: DiscardTarget, status: "nothing-to-discard" | "execution-in-progress" | "operation-in-progress"): DiscardPlan {
    return { status, repositoryId, target, changes: [], stagedCount: 0, unstagedCount: 0, untrackedCount: 0 };
  }
}
