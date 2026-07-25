import { GitAdapter } from "../git/GitAdapter";
import type { IGitAdapter, IRepositorySnapshotService } from "../git/interfaces";
import type { IOperationJournal } from "../journal/interfaces";
import { JournalEntryStatus } from "../journal/types";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import { TransactionRollbackFailedError } from "./errors";
import type { IGitTransactionManager } from "./interfaces";
import type { Transaction, TransactionOptions } from "./types";

// The mechanism that makes commit/push/merge/sync/branch operations
// reversible -- wraps an operation as capture-before -> attempt ->
// commit-or-rollback, journaling every step. Ref-based (git commits, branch
// pointers), deliberately a sibling to the existing tree-content undo
// mechanism (src/undo/UndoService), not a replacement: one reverts Claude's
// file edits, this reverts git's own state changes.
export class GitTransactionManager implements IGitTransactionManager {
  constructor(
    private readonly snapshotService: IRepositorySnapshotService,
    private readonly journal: IOperationJournal,
    private readonly repositoryRegistry: IRepositoryRegistry,
  ) {}

  async begin(options: TransactionOptions): Promise<Transaction> {
    const gitAdapter: IGitAdapter = new GitAdapter(this.repositoryRegistry, options.repositoryId);
    const beforeRef =
      options.rollbackStrategy === "restore-tree" ? await this.snapshotService.capture(options.repositoryId) : await gitAdapter.headSha();

    const entry = await this.journal.record({
      repositoryId: options.repositoryId,
      correlationId: options.correlationId,
      operation: options.operation,
      status: JournalEntryStatus.InProgress,
      rollbackStrategy: options.rollbackStrategy,
      beforeRef,
      afterRef: undefined,
      startedAt: new Date(),
      completedAt: undefined,
      error: undefined,
      metadata: options.metadata ?? {},
    });

    const { journal, snapshotService, repositoryRegistry } = this;
    let settled = false;

    return {
      journalEntryId: entry.id,
      beforeRef,

      async commit(afterRef: string): Promise<void> {
        if (settled) return;
        settled = true;
        await journal.update(entry.id, { status: JournalEntryStatus.Completed, afterRef, completedAt: new Date() });
      },

      async rollback(): Promise<void> {
        if (settled) return;
        settled = true;
        try {
          const rollbackAdapter: IGitAdapter = new GitAdapter(repositoryRegistry, options.repositoryId);
          if (options.rollbackStrategy === "reset-hard") {
            await rollbackAdapter.resetHard(beforeRef);
          } else if (options.rollbackStrategy === "reset-soft") {
            await rollbackAdapter.resetSoft(beforeRef);
          } else {
            const liveRef = await rollbackAdapter.createSnapshot();
            const changed = await snapshotService.diff(options.repositoryId, beforeRef, liveRef);
            const filesToRestore = changed.filter((file) => file.status !== "added").map((file) => file.path);
            const filesToDelete = changed.filter((file) => file.status === "added").map((file) => file.path);
            await snapshotService.restore(options.repositoryId, beforeRef, filesToRestore, filesToDelete);
          }
          await journal.update(entry.id, { status: JournalEntryStatus.RolledBack, completedAt: new Date() });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await journal.update(entry.id, { status: JournalEntryStatus.Failed, error: message, completedAt: new Date() });
          throw new TransactionRollbackFailedError(entry.id, message);
        }
      },
    };
  }
}
