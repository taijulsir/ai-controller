import type { JournalOperationType } from "../journal/types";
import type { RecoveryPlan } from "../recovery/types";

export enum PreflightCheck {
  NotDetachedHead = "not-detached-head",
  WorkingTreeClean = "working-tree-clean",
  TargetBranchExists = "target-branch-exists",
  TargetNotCurrentBranch = "target-not-current-branch",
  NonEmptyCommitMessage = "non-empty-commit-message",
  HasChangesToCommit = "has-changes-to-commit",
  LocalIsFastForwardOfRemote = "local-is-fast-forward-of-remote",
  BranchNameAvailable = "branch-name-available",
  // Blocks any command while state is MergeInProgress / RebaseInProgress /
  // Recovering / etc.
  RepositoryStateIsClean = "repository-state-is-clean",
}

export type PreflightVerdict =
  | { kind: "pass" }
  | { kind: "fail"; reason: string; failedCheck: PreflightCheck };

export enum OperationClassification {
  ContinueAutomatically = "continue-automatically",
  RequestApproval = "request-approval",
  StopExecution = "stop-execution",
  RecommendRecovery = "recommend-recovery",
}

export enum DivergenceStrategy {
  Rebase = "rebase",
  Merge = "merge",
  Ask = "ask",
}

export interface OrchestratedOperationRequest<T> {
  operation: JournalOperationType;
  repositoryId: string;
  correlationId: string;
  input?: Record<string, string>;
  // Deviation from the Phase 0 freeze, noted in the implementation report:
  // this originally took `(transaction: Transaction) => Promise<T>`, with
  // Command Orchestrator opening the Transaction itself. By the time this
  // was wired up, IntelligentSyncEngine/RebaseEngine/MergeEngine (task #16)
  // already each opened and owned their own Transaction internally --
  // Command Orchestrator also opening one here would silently create a
  // second, orphaned, always-InProgress journal entry per operation, never
  // committed or rolled back by anything. The rule is now uniform instead:
  // whichever component performs the mutating git call owns the Transaction
  // for it (an Engine, or -- for the operations with no Engine, e.g.
  // commit/push/branch/discard -- the workflow itself, the same way an
  // Engine does it).
  run: () => Promise<T>;
}

export type OrchestratedOperationResult<T> =
  | { kind: "executed"; value: T }
  | { kind: "blocked"; verdict: Extract<PreflightVerdict, { kind: "fail" }> }
  | { kind: "awaiting-approval"; correlationId: string }
  | { kind: "recommend-recovery"; plan: RecoveryPlan }
  // Renamed from "rolled-back" for the same reason as above: Command
  // Orchestrator no longer owns a Transaction it could roll back. This
  // reports that run() threw; the callee (Engine or workflow) is
  // responsible for its own Transaction's rollback/cleanup before the
  // error propagates here.
  | { kind: "failed"; error: string };

export interface ApprovalGateRequest {
  correlationId: string;
  summary: string;
  detail: string;
}
