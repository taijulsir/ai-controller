import type { IGitAdapter } from "../../git/interfaces";
import type { ICommandOrchestrator } from "../../gitorchestration/interfaces";
import type { IOperationJournal } from "../../journal/interfaces";
import { JournalEntryStatus, JournalOperationType } from "../../journal/types";
import { MissingTaskInputError } from "../errors";
import type { ITaskWorkflow } from "../interfaces";
import type { SwitchBranchTask, Task, WorkflowResult } from "../types";
import { runGated } from "./gitOrchestrationSupport";

// The dirty-tree check is now Pre-flight Validation Policy's job
// (PreflightCheck.WorkingTreeClean) -- UnsafeBranchSwitchError is gone.
// Journals directly (no IGitTransactionManager Transaction): switching
// branches re-points a ref, it doesn't change content, so none of
// reset-hard/reset-soft/restore-tree describe undoing it. rollbackStrategy
// "switch-back-to-branch" + metadata.previousBranch is what Safe Undo
// Framework reads to check the previous branch back out.
export class SwitchBranchWorkflow implements ITaskWorkflow {
  constructor(
    private readonly gitAdapter: IGitAdapter,
    private readonly commandOrchestrator: ICommandOrchestrator,
    private readonly journal: IOperationJournal,
    private readonly repositoryId: string,
    private readonly correlationId: string,
  ) {}

  async execute(task: Task, _signal: AbortSignal): Promise<WorkflowResult> {
    const { input } = task as SwitchBranchTask;
    if (!input?.branch) {
      throw new MissingTaskInputError(task.type, "branch");
    }
    const targetBranch = input.branch;

    return runGated(
      this.commandOrchestrator,
      {
        operation: JournalOperationType.SwitchBranch,
        repositoryId: this.repositoryId,
        correlationId: this.correlationId,
        input: { branch: targetBranch },
        run: async () => {
          const previousBranch = await this.gitAdapter.currentBranch();
          const entry = await this.journal.record({
            repositoryId: this.repositoryId,
            correlationId: this.correlationId,
            operation: JournalOperationType.SwitchBranch,
            status: JournalEntryStatus.InProgress,
            rollbackStrategy: "switch-back-to-branch",
            beforeRef: previousBranch,
            afterRef: targetBranch,
            startedAt: new Date(),
            completedAt: undefined,
            error: undefined,
            metadata: { previousBranch, branch: targetBranch },
          });
          try {
            await this.gitAdapter.checkout(targetBranch);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.journal.update(entry.id, { status: JournalEntryStatus.Failed, error: message, completedAt: new Date() });
            throw error;
          }
          await this.journal.update(entry.id, { status: JournalEntryStatus.Completed, completedAt: new Date() });
          return targetBranch;
        },
      },
      (branch) => branch,
    );
  }
}
