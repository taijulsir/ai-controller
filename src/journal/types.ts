export enum JournalEntryStatus {
  InProgress = "in-progress",
  Completed = "completed",
  RolledBack = "rolled-back",
  Failed = "failed",
}

export enum JournalOperationType {
  Fetch = "fetch",
  Sync = "sync",
  Merge = "merge",
  Rebase = "rebase",
  Commit = "commit",
  Push = "push",
  SwitchBranch = "switch-branch",
  CreateBranch = "create-branch",
  Discard = "discard",
  Undo = "undo",
}

// Deviation from the Phase 0 freeze, noted in the implementation report:
// added once Safe Undo Framework was actually implemented. A JournalEntry
// outlives the in-memory Transaction object that created it (a later /undo
// or /abort command is a separate request entirely), so the rollback
// mechanism used has to be persisted, not just held in a closure. The first
// three values are exactly IGitTransactionManager's own RollbackStrategy
// (src/gittransaction/types.ts) -- GitTransactionManager.begin() writes
// options.rollbackStrategy straight into this field. The next three cover
// operations that never open a Transaction at all, because none of
// reset-hard/reset-soft/restore-tree describes them: switch-branch and
// create-branch re-point a ref rather than change content, and push already
// reached a shared remote, so undoing it means a revert commit plus
// force-push-with-lease, not a local reset. Those workflows call
// IOperationJournal.record() directly instead of going through
// IGitTransactionManager. "read-only" covers fetch, which is journaled
// (if at all) as an already-Completed entry with nothing to roll back.
//
// This is also the single source of truth Safe Undo Framework's
// GitUndoPlan.strategy reuses (src/undo/types.ts) rather than maintaining a
// second, parallel enum that could silently drift from this one -- undoing
// a given JournalEntry always uses the exact mechanism it was recorded
// with, never a mechanism re-derived from JournalOperationType alone (which
// cannot distinguish, e.g., a commit's "reset-soft" from a sync's
// "reset-hard" -- both are JournalOperationType values whose correct
// rollback mechanism can differ per entry).
export type JournalRollbackStrategy =
  | "reset-hard"
  | "reset-soft"
  | "restore-tree"
  | "switch-back-to-branch"
  | "delete-branch"
  | "revert-and-force-push-with-lease"
  | "read-only";

export interface JournalEntry {
  id: string;
  repositoryId: string;
  correlationId: string;
  operation: JournalOperationType;
  status: JournalEntryStatus;
  rollbackStrategy: JournalRollbackStrategy;
  // tree-ish/commit SHA before the operation; undefined for read-only ops (fetch)
  beforeRef: string | undefined;
  // set once the operation completes
  afterRef: string | undefined;
  startedAt: Date;
  completedAt: Date | undefined;
  // set when status === Failed
  error: string | undefined;
  // e.g. { targetBranch: "feature-x" } for a merge
  metadata: Record<string, string>;
}

export interface JournalQuery {
  // Deviation from the Phase 0 freeze, noted in the implementation report:
  // added once Safe Undo Framework needed to re-fetch one specific entry
  // from only its id (the id it was given by a prior buildUndoPlan() call,
  // in an earlier request entirely) -- the frozen query shape had no way to
  // filter by id at all.
  id?: string;
  repositoryId?: string;
  operation?: JournalOperationType;
  status?: JournalEntryStatus;
  since?: Date;
  limit?: number;
}
