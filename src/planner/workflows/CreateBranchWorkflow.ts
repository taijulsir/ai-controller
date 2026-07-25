import type { IGitAdapter } from "../../git/interfaces";
import type { ICommandOrchestrator } from "../../gitorchestration/interfaces";
import type { IOperationJournal } from "../../journal/interfaces";
import { JournalEntryStatus, JournalOperationType } from "../../journal/types";
import { MissingTaskInputError } from "../errors";
import type { ITaskWorkflow } from "../interfaces";
import type { CreateBranchTask, Task, WorkflowResult } from "../types";
import { runGated } from "./gitOrchestrationSupport";

// No working-tree precondition, unlike SwitchBranchWorkflow (Pre-flight
// Validation Policy's own `case CreateBranch: return pass();` agrees):
// `git checkout -b` creates the new branch at the current commit and moves
// HEAD to it without changing any tracked file content, so it carries
// uncommitted changes forward safely. Journals directly, same reasoning as
// SwitchBranchWorkflow: rollbackStrategy "delete-branch" + metadata.branch
// is what Safe Undo Framework reads to delete the branch it created.
export class CreateBranchWorkflow implements ITaskWorkflow {
  constructor(
    private readonly gitAdapter: IGitAdapter,
    private readonly commandOrchestrator: ICommandOrchestrator,
    private readonly journal: IOperationJournal,
    private readonly repositoryId: string,
    private readonly correlationId: string,
  ) {}

  async execute(task: Task, _signal: AbortSignal): Promise<WorkflowResult> {
    const { input } = task as CreateBranchTask;
    if (!input?.branch) {
      throw new MissingTaskInputError(task.type, "branch");
    }
    const newBranch = input.branch;

    return runGated(
      this.commandOrchestrator,
      {
        operation: JournalOperationType.CreateBranch,
        repositoryId: this.repositoryId,
        correlationId: this.correlationId,
        input: { branch: newBranch },
        run: async () => {
          const beforeRef = await this.gitAdapter.headSha();
          const entry = await this.journal.record({
            repositoryId: this.repositoryId,
            correlationId: this.correlationId,
            operation: JournalOperationType.CreateBranch,
            status: JournalEntryStatus.InProgress,
            rollbackStrategy: "delete-branch",
            beforeRef,
            afterRef: newBranch,
            startedAt: new Date(),
            completedAt: undefined,
            error: undefined,
            metadata: { branch: newBranch },
          });
          try {
            await this.gitAdapter.createBranch(newBranch);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.journal.update(entry.id, { status: JournalEntryStatus.Failed, error: message, completedAt: new Date() });
            throw error;
          }
          await this.journal.update(entry.id, { status: JournalEntryStatus.Completed, completedAt: new Date() });
          return newBranch;
        },
      },
      (branch) => branch,
    );
  }
}
