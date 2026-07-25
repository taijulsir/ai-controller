import type { RepositoryHealthReport } from "../git/types";
import { JournalOperationType } from "../journal/types";
import type { IPreflightValidationPolicy } from "./interfaces";
import { PreflightCheck, type PreflightVerdict } from "./types";

const IN_PROGRESS_OPERATIONS: ReadonlySet<JournalOperationType> = new Set([
  JournalOperationType.Sync,
  JournalOperationType.Merge,
  JournalOperationType.Rebase,
  JournalOperationType.Commit,
  JournalOperationType.Push,
  JournalOperationType.SwitchBranch,
  JournalOperationType.CreateBranch,
  JournalOperationType.Discard,
]);

function pass(): PreflightVerdict {
  return { kind: "pass" };
}

function fail(failedCheck: PreflightCheck, reason: string): PreflightVerdict {
  return { kind: "fail", failedCheck, reason };
}

// One pure policy object, replacing the copy-pasted isClean/detached-HEAD
// checks SyncWorkflow/MergeWorkflow/SwitchBranchWorkflow each hand-rolled
// before this phase. Same shape as the existing ApprovalPolicy/
// UndoableTaskPolicy/TaskCancellationPolicy: zero I/O, takes an
// already-fetched report, returns a typed verdict.
export class PreflightValidationPolicy implements IPreflightValidationPolicy {
  validate(operation: JournalOperationType, report: RepositoryHealthReport, input: Record<string, string> = {}): PreflightVerdict {
    // Universal: no mutating operation may proceed while the repository is
    // mid-merge/rebase/cherry-pick/revert/bisect -- attempting one on top of
    // another is exactly the "fragmented, manual decisions" failure mode the
    // approved review's problem 10 identified. Fetch and read-only queries
    // are exempt (fetch never touches the working tree or index).
    if (IN_PROGRESS_OPERATIONS.has(operation) && report.inProgressOperation) {
      return fail(
        PreflightCheck.RepositoryStateIsClean,
        `Cannot run "${operation}": a ${report.inProgressOperation.kind} is already in progress. Resolve, /resume, or /abort it first.`,
      );
    }

    switch (operation) {
      case JournalOperationType.Fetch:
        return pass();

      case JournalOperationType.Sync:
      case JournalOperationType.Rebase:
        return this.requireAttachedAndClean(operation, report);

      case JournalOperationType.Merge: {
        const attachedAndClean = this.requireAttachedAndClean(operation, report);
        if (attachedAndClean.kind === "fail") return attachedAndClean;
        const targetBranch = input.targetBranch;
        if (targetBranch && targetBranch === report.branch) {
          return fail(PreflightCheck.TargetNotCurrentBranch, `Cannot merge "${targetBranch}" into itself.`);
        }
        return pass();
      }

      case JournalOperationType.Commit: {
        const message = input.message?.trim();
        if (!message) {
          return fail(PreflightCheck.NonEmptyCommitMessage, `"commit" requires a non-empty message.`);
        }
        if (report.isClean) {
          return fail(PreflightCheck.HasChangesToCommit, "Nothing to commit -- the working tree is clean.");
        }
        return pass();
      }

      case JournalOperationType.Push: {
        if (report.upstream && !report.upstream.deleted && report.upstream.behind > 0) {
          return fail(
            PreflightCheck.LocalIsFastForwardOfRemote,
            `Cannot push: the local branch is ${report.upstream.behind} commit(s) behind its upstream. Run /sync first.`,
          );
        }
        return pass();
      }

      case JournalOperationType.SwitchBranch:
        return this.requireClean(operation, report);

      case JournalOperationType.CreateBranch:
      case JournalOperationType.Discard:
      case JournalOperationType.Undo:
        return pass();
    }
  }

  private requireAttachedAndClean(operation: JournalOperationType, report: RepositoryHealthReport): PreflightVerdict {
    if (report.detachedHead) {
      return fail(PreflightCheck.NotDetachedHead, `Cannot ${operation}: HEAD is detached, not on a branch.`);
    }
    return this.requireClean(operation, report);
  }

  private requireClean(operation: JournalOperationType, report: RepositoryHealthReport): PreflightVerdict {
    if (!report.isClean) {
      return fail(
        PreflightCheck.WorkingTreeClean,
        `Cannot ${operation}: the working tree has uncommitted changes ` +
          `(${report.staged.length} staged, ${report.unstaged.length} unstaged, ${report.untracked.length} untracked). Commit or discard them first.`,
      );
    }
    return pass();
  }
}
