import type { IGitAdapter } from "../../git/interfaces";
import type { IGitTransactionManager } from "../../gittransaction/interfaces";
import type { ICommandOrchestrator } from "../../gitorchestration/interfaces";
import { JournalOperationType } from "../../journal/types";
import { MissingTaskInputError } from "../errors";
import type { ITaskWorkflow } from "../interfaces";
import type { CreateCommitTask, Task, WorkflowResult } from "../types";
import { runGated } from "./gitOrchestrationSupport";

// "Nothing to commit"/empty-message validation is now Pre-flight Validation
// Policy's job (PreflightCheck.NonEmptyCommitMessage / HasChangesToCommit),
// enforced uniformly by Command Orchestrator -- this class only keeps the
// MissingTaskInputError guard, since CreateCommitTask.input is typed as
// required but task is only ever narrowed via an `as` cast here, not by the
// compiler. Opens its own Transaction (rollbackStrategy "reset-soft"):
// undoing a commit should preserve the diff as staged, not discard it --
// see RollbackStrategy's own doc comment in src/gittransaction/types.ts.
export class CreateCommitWorkflow implements ITaskWorkflow {
  constructor(
    private readonly gitAdapter: IGitAdapter,
    private readonly commandOrchestrator: ICommandOrchestrator,
    private readonly transactionManager: IGitTransactionManager,
    private readonly repositoryId: string,
    private readonly correlationId: string,
  ) {}

  async execute(task: Task, _signal: AbortSignal): Promise<WorkflowResult> {
    const { input } = task as CreateCommitTask;
    if (!input?.message) {
      throw new MissingTaskInputError(task.type, "message");
    }
    const message = input.message;

    return runGated(
      this.commandOrchestrator,
      {
        operation: JournalOperationType.Commit,
        repositoryId: this.repositoryId,
        correlationId: this.correlationId,
        input: { message },
        run: async () => {
          const transaction = await this.transactionManager.begin({
            operation: JournalOperationType.Commit,
            repositoryId: this.repositoryId,
            correlationId: this.correlationId,
            rollbackStrategy: "reset-soft",
            metadata: { message },
          });
          try {
            await this.gitAdapter.stageAll();
            await this.gitAdapter.commit(message);
          } catch (error) {
            await transaction.rollback();
            throw error;
          }
          await transaction.commit(await this.gitAdapter.headSha());
        },
      },
      () => undefined,
    );
  }
}
