import { GitAdapter } from "../git/GitAdapter";
import type { IRepositorySnapshotService } from "../git/interfaces";
import type { IApprovalGate } from "../gitorchestration/interfaces";
import { JournalEntryStatus } from "../journal/types";
import type { IOperationJournal } from "../journal/interfaces";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import { AlreadyPushedError } from "./errors";
import type { ISafeUndoFramework } from "./interfaces";
import type { GitUndoPlan } from "./types";

// The ref-based sibling to today's tree-content UndoService. Reads the
// Operation Journal (not ExecutionCheckpoint) to reverse a specific
// git-mutating operation. /undo's Telegram surface stays one command --
// ApplicationService.undoLastExecution() builds a plan from both this
// framework and the existing UndoService; for a bare "/undo confirm" it acts
// on whichever plan is more recent (GitUndoPlan.recordedAt vs.
// UndoPlan.capturedAt), and for an explicit "/undo <hash>" it resolves
// against this framework's plan alone (see that method's own doc comment).
//
// Product decision: buildUndoPlan() below deliberately queries only the
// single most recent completed journal entry (limit: 1) -- it is not a
// partial implementation of a lookup-by-hash feature. "/undo <hash>" only
// ever supports the latest undoable Git operation; undoing an older,
// already-superseded journal entry is intentionally out of scope (see the
// architecture review referenced from ApplicationService.undoLastExecution())
// because the recorded rollback strategy for a non-latest entry can no
// longer be applied safely -- reset-hard/reset-soft would silently discard
// every commit made after it, not just undo that one entry.
export class SafeUndoFramework implements ISafeUndoFramework {
  constructor(
    private readonly journal: IOperationJournal,
    private readonly repositoryRegistry: IRepositoryRegistry,
    private readonly snapshotService: IRepositorySnapshotService,
    private readonly approvalGate: IApprovalGate,
  ) {}

  // Deliberately the single most recent completed, non-read-only entry --
  // never a search. See this class's own doc comment above for why that is
  // a product decision, not a gap.
  async buildUndoPlan(repositoryId: string): Promise<GitUndoPlan | undefined> {
    const [entry] = await this.journal.query({ repositoryId, status: JournalEntryStatus.Completed, limit: 1 });
    if (!entry || entry.rollbackStrategy === "read-only") {
      // "read-only" covers fetch -- nothing meaningful to reverse.
      return undefined;
    }
    return {
      journalEntryId: entry.id,
      operation: entry.operation,
      strategy: entry.rollbackStrategy,
      requiresApproval: entry.rollbackStrategy === "revert-and-force-push-with-lease",
      recordedAt: entry.completedAt ?? entry.startedAt,
      afterRef: entry.afterRef,
    };
  }

  async executeUndoPlan(plan: GitUndoPlan): Promise<void> {
    const entry = await this.journal.getById(plan.journalEntryId);
    if (!entry) {
      return;
    }

    if (plan.requiresApproval) {
      const approved = await this.approvalGate.requestApproval({
        correlationId: entry.repositoryId,
        summary: `Undo a pushed ${entry.operation}`,
        detail: "This will create a revert commit and force-push-with-lease, since the original change already reached the shared remote.",
      });
      if (!approved) {
        throw new AlreadyPushedError(entry.id);
      }
    }

    const gitAdapter = new GitAdapter(this.repositoryRegistry, entry.repositoryId);

    switch (entry.rollbackStrategy) {
      case "reset-hard":
        if (entry.beforeRef) await gitAdapter.resetHard(entry.beforeRef);
        break;
      case "reset-soft":
        if (entry.beforeRef) await gitAdapter.resetSoft(entry.beforeRef);
        break;
      case "restore-tree": {
        if (!entry.beforeRef) break;
        // Mirrors GitTransactionManager.rollback()'s own restore-tree
        // branch exactly -- the same mechanism, invoked later from a
        // separate /undo request rather than from within the original
        // Transaction's own rollback() closure.
        const liveRef = await gitAdapter.createSnapshot();
        const changed = await this.snapshotService.diff(entry.repositoryId, entry.beforeRef, liveRef);
        const filesToRestore = changed.filter((file) => file.status !== "added").map((file) => file.path);
        const filesToDelete = changed.filter((file) => file.status === "added").map((file) => file.path);
        await this.snapshotService.restore(entry.repositoryId, entry.beforeRef, filesToRestore, filesToDelete);
        break;
      }
      case "delete-branch": {
        const branch = entry.metadata.branch;
        if (branch) await gitAdapter.deleteBranch(branch);
        break;
      }
      case "switch-back-to-branch": {
        const previousBranch = entry.metadata.previousBranch;
        if (previousBranch) await gitAdapter.checkout(previousBranch);
        break;
      }
      case "revert-and-force-push-with-lease":
        if (entry.afterRef) await gitAdapter.revertCommit(entry.afterRef);
        await gitAdapter.forcePushWithLease();
        break;
      case "read-only":
        // Unreachable -- buildUndoPlan() already filters "read-only" entries
        // out, so no plan pointing at one is ever passed here.
        break;
    }

    await this.journal.update(entry.id, { status: JournalEntryStatus.RolledBack, completedAt: new Date() });
  }
}
