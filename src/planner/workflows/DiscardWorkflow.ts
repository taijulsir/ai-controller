import type { IGitAdapter } from "../../git/interfaces";
import type { IGitTransactionManager } from "../../gittransaction/interfaces";
import type { ICommandOrchestrator } from "../../gitorchestration/interfaces";
import { JournalOperationType } from "../../journal/types";
import type { ITaskWorkflow } from "../interfaces";
import type { Task, WorkflowResult } from "../types";
import { runGated } from "./gitOrchestrationSupport";

// New command (/discard): discards every uncommitted change (staged,
// unstaged, and untracked) in one shot -- there is no partial/pathspec
// form, matching RecoveryCommand's own "discard-working-tree" step (this is
// the same operation, reachable directly rather than only via /recover).
// Opens its own Transaction with rollbackStrategy "restore-tree" -- the one
// case where "before" has to be a tree snapshot rather than a commit ref,
// since discard has no commit to reset to, only working-tree content that
// would otherwise be lost. This is exactly why /undo can still reverse a
// /discard: Git Transaction Manager captures that snapshot in begin(),
// before the discard itself ever runs.
export class DiscardWorkflow implements ITaskWorkflow {
  constructor(
    private readonly gitAdapter: IGitAdapter,
    private readonly commandOrchestrator: ICommandOrchestrator,
    private readonly transactionManager: IGitTransactionManager,
    private readonly repositoryId: string,
    private readonly correlationId: string,
  ) {}

  async execute(_task: Task, _signal: AbortSignal): Promise<WorkflowResult> {
    return runGated(
      this.commandOrchestrator,
      {
        operation: JournalOperationType.Discard,
        repositoryId: this.repositoryId,
        correlationId: this.correlationId,
        run: async () => {
          const transaction = await this.transactionManager.begin({
            operation: JournalOperationType.Discard,
            repositoryId: this.repositoryId,
            correlationId: this.correlationId,
            rollbackStrategy: "restore-tree",
          });
          try {
            await this.gitAdapter.resetHard("HEAD");
            await this.gitAdapter.cleanWorkingTree();
          } catch (error) {
            await transaction.rollback();
            throw error;
          }
          await transaction.commit(await this.gitAdapter.headSha());
          return "Discarded all uncommitted changes.";
        },
      },
      (message) => message,
    );
  }
}
