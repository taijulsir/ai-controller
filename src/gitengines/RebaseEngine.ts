import { GitAdapter } from "../git/GitAdapter";
import type { IGitTransactionManager } from "../gittransaction/interfaces";
import { JournalOperationType } from "../journal/types";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import type { IConflictResolutionEngine, IRebaseEngine } from "./interfaces";
import type { RebaseOutcome } from "./types";

// Symmetric to MergeEngine: pre-flight validation happens one layer up (the
// Command Orchestrator), so this class only ever runs once a caller has
// already confirmed the tree is clean and HEAD is attached. On conflict, the
// transaction is deliberately left InProgress rather than rolled back --
// git's own rebase state is already paused, and rolling back here would
// discard progress a /resume could otherwise continue from. /abort (not
// this class) is what unwinds it.
export class RebaseEngine implements IRebaseEngine {
  constructor(
    private readonly repositoryRegistry: IRepositoryRegistry,
    private readonly transactionManager: IGitTransactionManager,
    private readonly conflictResolutionEngine: IConflictResolutionEngine,
  ) {}

  async rebase(repositoryId: string, correlationId: string, ontoRef: string, _signal: AbortSignal): Promise<RebaseOutcome> {
    const gitAdapter = new GitAdapter(this.repositoryRegistry, repositoryId);
    const transaction = await this.transactionManager.begin({
      operation: JournalOperationType.Rebase,
      repositoryId,
      correlationId,
      rollbackStrategy: "reset-hard",
      metadata: { ontoRef },
    });

    try {
      await gitAdapter.rebase(ontoRef);
    } catch {
      const conflict = await this.conflictResolutionEngine.analyze(repositoryId);
      return { kind: "conflict", conflict };
    }

    const afterRef = await gitAdapter.headSha();
    if (afterRef === transaction.beforeRef) {
      await transaction.commit(afterRef);
      return { kind: "no-op" };
    }
    const rewrittenCommits = await gitAdapter.countCommitsBetween(transaction.beforeRef, afterRef);
    await transaction.commit(afterRef);
    return { kind: "completed", rewrittenCommits };
  }
}
