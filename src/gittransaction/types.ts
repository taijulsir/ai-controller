import type { JournalOperationType } from "../journal/types";

// Which mechanism rollback() actually uses -- matches the approved review's
// own Rollback Strategy exactly (§3, component 15): fast-forward/merge/
// rebase/sync/push all reset to a prior commit ref (their Pre-flight
// Validation already requires a clean tree beforehand, so a hard reset is
// both safe and complete); commit specifically soft-resets, preserving the
// diff as staged rather than discarding it; discard has no commit to reset
// to at all -- only working-tree content to restore.
//
// Deviation from the Phase 0 freeze, noted in the implementation report:
// this field did not exist in the frozen TransactionOptions. It became
// necessary once rollback() was actually implemented -- restoring tree
// content alone cannot undo a commit or merge that already moved HEAD, and
// the review itself already specified different rollback mechanics per
// operation; this field is what makes Transaction capable of the mechanism
// the review already called for, not a new architectural concept.
export type RollbackStrategy = "reset-hard" | "reset-soft" | "restore-tree";

export interface TransactionOptions {
  operation: JournalOperationType;
  repositoryId: string;
  correlationId: string;
  rollbackStrategy: RollbackStrategy;
  metadata?: Record<string, string>;
}

// Returned by IGitTransactionManager.begin() -- a unit-of-work object, not a
// data record. The journal entry it wraps is created eagerly (status:
// InProgress) so a crash between begin() and commit()/rollback() is
// detectable on the next health check (approved review, §9.5 edge case).
export interface Transaction {
  journalEntryId: string;
  // A commit SHA for reset-hard/reset-soft strategies, a tree-ish snapshot
  // for restore-tree -- see RollbackStrategy above for which is which.
  beforeRef: string;
  commit(afterRef: string): Promise<void>;
  rollback(): Promise<void>;
}
