import type { IGitAdapter } from "../../git/interfaces";
import type { ICommandOrchestrator } from "../../gitorchestration/interfaces";
import type { IOperationJournal } from "../../journal/interfaces";
import { JournalEntryStatus, JournalOperationType } from "../../journal/types";
import type { ITaskWorkflow } from "../interfaces";
import type { Task, WorkflowResult } from "../types";
import { runGated } from "./gitOrchestrationSupport";

// Push never opens an IGitTransactionManager Transaction: none of
// reset-hard/reset-soft/restore-tree describe undoing it -- a push doesn't
// move local HEAD, it publishes what's already there. It journals directly
// instead, with rollbackStrategy "revert-and-force-push-with-lease" -- Safe
// Undo Framework's one case that always requires approval (see
// AlreadyPushedError), since undoing it means a revert commit and a
// force-push-with-lease, not a local reset.
export class PushChangesWorkflow implements ITaskWorkflow {
  constructor(
    private readonly gitAdapter: IGitAdapter,
    private readonly commandOrchestrator: ICommandOrchestrator,
    private readonly journal: IOperationJournal,
    private readonly repositoryId: string,
    private readonly correlationId: string,
  ) {}

  async execute(_task: Task, _signal: AbortSignal): Promise<WorkflowResult> {
    return runGated(
      this.commandOrchestrator,
      {
        operation: JournalOperationType.Push,
        repositoryId: this.repositoryId,
        correlationId: this.correlationId,
        run: async () => {
          const ref = await this.gitAdapter.headSha();
          const entry = await this.journal.record({
            repositoryId: this.repositoryId,
            correlationId: this.correlationId,
            operation: JournalOperationType.Push,
            status: JournalEntryStatus.InProgress,
            rollbackStrategy: "revert-and-force-push-with-lease",
            beforeRef: ref,
            afterRef: ref,
            startedAt: new Date(),
            completedAt: undefined,
            error: undefined,
            metadata: {},
          });
          try {
            await this.gitAdapter.push();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.journal.update(entry.id, { status: JournalEntryStatus.Failed, error: message, completedAt: new Date() });
            throw error;
          }
          await this.journal.update(entry.id, { status: JournalEntryStatus.Completed, completedAt: new Date() });
        },
      },
      () => undefined,
    );
  }
}
