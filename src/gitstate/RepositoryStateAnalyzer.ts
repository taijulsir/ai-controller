import type { RepositoryHealthReport } from "../git/types";
import { InProgressOperationKind } from "../git/types";
import type { IRepositoryStateAnalyzer } from "./interfaces";
import { RepositoryState } from "./types";

const IN_PROGRESS_STATE_BY_KIND: Record<InProgressOperationKind, RepositoryState> = {
  [InProgressOperationKind.Merge]: RepositoryState.MergeInProgress,
  [InProgressOperationKind.Rebase]: RepositoryState.RebaseInProgress,
  [InProgressOperationKind.CherryPick]: RepositoryState.CherryPickInProgress,
  [InProgressOperationKind.Revert]: RepositoryState.RevertInProgress,
  [InProgressOperationKind.Bisect]: RepositoryState.BisectInProgress,
};

// Priority order matters: an interrupted operation (process killed mid-op)
// always wins over a merely in-progress one, which wins over detached HEAD,
// which wins over divergence, which wins over a plain dirty tree -- each
// condition is strictly more urgent than the ones below it. Unrecoverable is
// deliberately never produced here: it requires a judgment (e.g. git fsck
// corruption) this pure classifier has no data for, and belongs to Recovery
// Planner/Repository Recovery Workflow instead.
export class RepositoryStateAnalyzer implements IRepositoryStateAnalyzer {
  classify(report: RepositoryHealthReport): RepositoryState {
    if (report.interruptedOperation) {
      return RepositoryState.Recovering;
    }
    if (report.inProgressOperation) {
      return IN_PROGRESS_STATE_BY_KIND[report.inProgressOperation.kind];
    }
    if (report.detachedHead) {
      return RepositoryState.DetachedHead;
    }
    if (report.upstream?.diverged) {
      return RepositoryState.Diverged;
    }
    if (!report.isClean) {
      return RepositoryState.Dirty;
    }
    return RepositoryState.Clean;
  }
}
