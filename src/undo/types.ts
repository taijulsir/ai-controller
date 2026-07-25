import type { CommitSummary } from "../git/types";
import type { JournalOperationType, JournalRollbackStrategy } from "../journal/types";
import type { TaskType } from "../planner/types";

export type UndoPlanStatus = "ready" | "nothing-to-undo" | "execution-in-progress" | "drift-detected";

// Phase 1's output: an immutable, plain-data description of what /undo would
// do, computed once and never mutated afterward -- built and (for the
// "ready" case) executed back-to-back with no gap today, but the split
// itself is what leaves room for a future gap (a preview command, a
// confirmation round-trip) without redesigning either phase. A caller that
// introduces such a gap must rebuild the plan immediately before executing
// it rather than reusing a possibly-stale one -- canUndo/conflictingFiles
// describe the repository's state at build time, not at whatever later
// moment execution might happen.
export interface UndoPlan {
  status: UndoPlanStatus;
  canUndo: boolean;
  repositoryId: string;
  checkpointId?: string;
  correlationId?: string;
  taskType?: TaskType;
  // Paths that existed in the checkpoint's beforeSnapshot -- restoring means
  // checking their old content back out.
  filesToRestore: string[];
  // Paths that did not exist in beforeSnapshot -- restoring means deleting
  // them, since no checkout/restore invocation can express "this path should
  // not exist".
  filesToDelete: string[];
  // Non-empty only when status === "drift-detected": paths this execution
  // changed that no longer match its own recorded afterSnapshot, meaning
  // something else (a manual edit, a later execution) touched them since --
  // undoing anyway would silently destroy that unrelated change.
  conflictingFiles: string[];
  // Present only when status === "ready" -- needed by executeUndoPlan() to
  // actually perform the restore. Not meant for display; ResponseFormatter
  // never reads this field.
  beforeSnapshot?: string;
  // Present whenever a checkpoint was found (drift-detected/ready), absent
  // for nothing-to-undo/execution-in-progress. /undo's single command
  // surface (ApplicationService.undoLastExecution()) compares this against
  // GitUndoPlan.recordedAt below to decide which of the two undo mechanisms
  // -- this tree-content one, or Safe Undo Framework's ref-based one -- is
  // actually the most recent undoable thing for the repository.
  capturedAt?: Date;
}

// The ref-based sibling to UndoPlan above -- reverses a git-native mutation
// via the Operation Journal, not a Claude-editing task's tree snapshot.
// `strategy` reuses JournalRollbackStrategy directly (see its doc comment in
// src/journal/types.ts) rather than a second, parallel enum: the mechanism
// that undoes a given JournalEntry is always exactly the one it was
// recorded with, read straight off the entry, never re-derived from its
// operation type.
export interface GitUndoPlan {
  journalEntryId: string;
  operation: JournalOperationType;
  strategy: JournalRollbackStrategy;
  // true whenever the operation already reached the remote (a push) -- the
  // one case Safe Undo Framework refuses to act on without explicit approval.
  requiresApproval: boolean;
  // The JournalEntry's own completedAt (or startedAt, for the rare case a
  // completed entry somehow has no completedAt) -- the git-native sibling of
  // UndoPlan.capturedAt above, compared against it to decide which undo
  // mechanism actually reflects the repository's most recent change.
  recordedAt: Date;
  // Git History & Inspection System: the JournalEntry's own afterRef,
  // carried straight through unchanged -- the commit "/undo <hash>" lets a
  // user confirm against without remembering it, so ApplicationService never
  // needs a second journal lookup just to show/validate which commit this
  // plan would actually undo. Corrected: this is NOT always a commit --
  // SwitchBranchWorkflow/CreateBranchWorkflow (rollbackStrategy
  // "switch-back-to-branch"/"delete-branch") set it to a *branch name*, since
  // neither operation's undo is expressed as a git ref at all (see
  // SafeUndoFramework.executeUndoPlan's own switch, which reads
  // entry.metadata.previousBranch/entry.metadata.branch for those two
  // strategies, never this field). Only a genuine commit reference for the
  // other, ref-based strategies (reset-hard/reset-soft/restore-tree/
  // revert-and-force-push-with-lease) -- callers must check `strategy`
  // before presenting this value as "commit X" (see
  // ApplicationService.undoLastExecution()).
  afterRef: string | undefined;
}

export type UndoOutcome =
  | { kind: "nothing-to-undo" }
  | { kind: "execution-in-progress" }
  | { kind: "drift-detected"; checkpointId: string; taskType: TaskType; conflictingFiles: string[] }
  | { kind: "undone"; checkpointId: string; taskType: TaskType; restoredFiles: string[]; deletedFiles: string[] }
  // /undo's git-native outcome, produced when Safe Undo Framework's plan was
  // the more recent of the two (see ApplicationService.undoLastExecution()).
  | { kind: "git-undone"; operation: JournalOperationType }
  // Git History & Inspection System: a bare "/undo" no longer acts -- it
  // shows recent commits for reference and asks the user to reply with
  // "/undo <hash>" instead. Deliberately decoupled from the actual undo
  // candidate (built only once a target is given, see undoLastExecution's
  // own doc comment) -- this is a cheap, generic reference list, not a
  // preview of one specific plan.
  | { kind: "preview"; commits: CommitSummary[] }
  // "/undo <hash>" where <hash> doesn't match the commit Safe Undo
  // Framework's plan would actually undo (or match its prefix) --
  // expectedHash/operation describe what the real candidate is, so
  // ResponseFormatter can tell the user exactly what to type instead.
  | { kind: "target-mismatch-git"; expectedHash: string; operation: JournalOperationType; givenTarget: string }
  // "/undo <hash>" where the actual candidate is a Claude-editing task
  // snapshot, which has no commit hash to match against at all -- the user
  // must reply with the literal "/undo confirm" instead.
  | { kind: "target-requires-confirm"; taskType: TaskType }
  // "/undo <hash>" where the actual candidate is a git-native operation
  // whose rollbackStrategy is branch-shaped, not commit-shaped
  // ("switch-back-to-branch"/"delete-branch" -- see GitUndoPlan.afterRef's
  // own doc comment) -- there is no commit to match against, so (unlike
  // target-mismatch-git) this is never presented as "commit X"; the user
  // must reply with the literal "/undo confirm" instead, same as the
  // task-snapshot case above.
  | { kind: "target-requires-confirm-git"; operation: JournalOperationType };
