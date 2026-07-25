import { ApprovalDeclinedError, OperationRequiresRecoveryError, PreflightValidationFailedError } from "../../gitorchestration/errors";
import type { ICommandOrchestrator } from "../../gitorchestration/interfaces";
import type { OrchestratedOperationRequest } from "../../gitorchestration/types";
import type { MergeOutcome, RebaseOutcome, SyncOutcome } from "../../gitengines/types";
import type { WorkflowResult } from "../types";

// The one place every git-native Workflow's execute() routes an
// OrchestratedOperationResult back into the WorkflowResult/thrown-error
// shape TaskPlanner already expects (see TaskPlanner.run()'s catch block --
// any thrown error becomes a failed TaskResult with that error's message).
// Reused by every retrofitted Workflow (fetch/sync/merge/rebase/commit/
// push/switch-branch/create-branch/discard) instead of each duplicating
// this same five-way switch.
export async function runGated<T>(
  commandOrchestrator: ICommandOrchestrator,
  request: OrchestratedOperationRequest<T>,
  describe: (value: T) => string | undefined,
): Promise<WorkflowResult> {
  const result = await commandOrchestrator.execute(request);
  switch (result.kind) {
    case "executed":
      return { success: true, output: describe(result.value) };
    case "blocked":
      throw new PreflightValidationFailedError(result.verdict);
    case "awaiting-approval":
      throw new ApprovalDeclinedError(result.correlationId);
    case "recommend-recovery":
      throw new OperationRequiresRecoveryError(result.plan);
    case "failed":
      throw new Error(result.error);
  }
}

// Shared by MergeWorkflow and (indirectly, via describeSyncOutcome) SyncWorkflow
// -- one place a MergeOutcome becomes operator-facing text.
export function describeMergeOutcome(outcome: MergeOutcome): string {
  switch (outcome.kind) {
    case "already-up-to-date":
      return "Already up to date.";
    case "fast-forwarded":
      return "Fast-forwarded to the target branch.";
    case "merged":
      return `Merged. New commit: ${outcome.commitSha}.`;
    case "conflict":
      return `Merge produced ${outcome.conflict.files.length} conflicted file(s), ${outcome.conflict.autoResolvableCount} auto-resolvable. Use /resume once resolved, or /abort to cancel.`;
  }
}

// Shared by RebaseWorkflow and (indirectly, via describeSyncOutcome) SyncWorkflow.
export function describeRebaseOutcome(outcome: RebaseOutcome): string {
  switch (outcome.kind) {
    case "no-op":
      return "Nothing to rebase; already up to date.";
    case "completed":
      return `Rebase completed. ${outcome.rewrittenCommits} commit(s) rewritten.`;
    case "conflict":
      return `Rebase produced ${outcome.conflict.files.length} conflicted file(s), ${outcome.conflict.autoResolvableCount} auto-resolvable. Use /resume once resolved, or /abort to cancel.`;
  }
}

export function describeSyncOutcome(outcome: SyncOutcome): string {
  switch (outcome.kind) {
    case "up-to-date":
      return "Already up to date.";
    case "fast-forwarded":
      return `Fast-forwarded to ${outcome.toRef}.`;
    case "declined":
      return "Sync declined -- the branch has diverged and reconciliation was not approved.";
    case "delegated":
      return outcome.to === "rebase" ? describeRebaseOutcome(outcome.outcome as RebaseOutcome) : describeMergeOutcome(outcome.outcome as MergeOutcome);
  }
}
