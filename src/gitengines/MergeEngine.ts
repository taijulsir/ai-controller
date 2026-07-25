import { GitAdapter } from "../git/GitAdapter";
import type { IGitTransactionManager } from "../gittransaction/interfaces";
import { JournalOperationType } from "../journal/types";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import type { IConflictResolutionEngine, IMergeEngine } from "./interfaces";
import type { MergeOutcome } from "./types";

// Formalizes today's MergeWorkflow logic (fast-forward check -> real merge
// -> conflict handling) as its own component, now sharing the Conflict
// Resolution Engine with RebaseEngine instead of hand-rolling its own
// abort-only handling. No longer responsible for upstream reconciliation --
// that's IntelligentSyncEngine's job; this always merges one explicitly
// named branch.
export class MergeEngine implements IMergeEngine {
  constructor(
    private readonly repositoryRegistry: IRepositoryRegistry,
    private readonly transactionManager: IGitTransactionManager,
    private readonly conflictResolutionEngine: IConflictResolutionEngine,
  ) {}

  async merge(repositoryId: string, correlationId: string, targetBranch: string, _signal: AbortSignal): Promise<MergeOutcome> {
    const gitAdapter = new GitAdapter(this.repositoryRegistry, repositoryId);

    const alreadyMerged = await gitAdapter.isAncestor(targetBranch, "HEAD");
    if (alreadyMerged) {
      return { kind: "already-up-to-date" };
    }

    const canFastForward = await gitAdapter.isAncestor("HEAD", targetBranch);
    if (canFastForward) {
      const transaction = await this.transactionManager.begin({
        operation: JournalOperationType.Merge,
        repositoryId,
        correlationId,
        rollbackStrategy: "reset-hard",
        metadata: { targetBranch, strategy: "fast-forward" },
      });
      await gitAdapter.fastForward(targetBranch);
      await transaction.commit(await gitAdapter.headSha());
      return { kind: "fast-forwarded" };
    }

    const transaction = await this.transactionManager.begin({
      operation: JournalOperationType.Merge,
      repositoryId,
      correlationId,
      rollbackStrategy: "reset-hard",
      metadata: { targetBranch, strategy: "no-ff" },
    });

    try {
      await gitAdapter.mergeBranch(targetBranch);
    } catch {
      // Left InProgress deliberately -- see RebaseEngine's own doc comment
      // for why a conflict never triggers an automatic rollback here.
      const conflict = await this.conflictResolutionEngine.analyze(repositoryId);
      return { kind: "conflict", conflict };
    }

    const afterRef = await gitAdapter.headSha();
    await transaction.commit(afterRef);
    return { kind: "merged", commitSha: afterRef };
  }
}
