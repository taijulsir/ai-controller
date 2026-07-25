import type { IMergeEngine } from "../../gitengines/interfaces";
import type { ICommandOrchestrator } from "../../gitorchestration/interfaces";
import { JournalOperationType } from "../../journal/types";
import { MissingTaskInputError } from "../errors";
import type { ITaskWorkflow } from "../interfaces";
import type { MergeTask, Task, WorkflowResult } from "../types";
import { describeMergeOutcome, runGated } from "./gitOrchestrationSupport";

// Formalizes today's fast-forward/merge/conflict logic as Merge Engine
// (src/gitengines/MergeEngine.ts), shared with Rebase Engine's own Conflict
// Resolution Engine instead of this workflow hand-rolling abort-only
// handling. Detached-HEAD/same-branch/dirty-tree checks are now Pre-flight
// Validation Policy's job (see PreflightCheck.TargetNotCurrentBranch etc.),
// enforced uniformly by Command Orchestrator -- DetachedHeadError/
// SameBranchMergeError/UnsafeGitOperationError/MergeConflictError are gone.
export class MergeWorkflow implements ITaskWorkflow {
  constructor(
    private readonly commandOrchestrator: ICommandOrchestrator,
    private readonly mergeEngine: IMergeEngine,
    private readonly repositoryId: string,
    private readonly correlationId: string,
  ) {}

  async execute(task: Task, signal: AbortSignal): Promise<WorkflowResult> {
    const { input } = task as MergeTask;
    if (!input?.branch) {
      throw new MissingTaskInputError(task.type, "branch");
    }
    const targetBranch = input.branch;

    return runGated(
      this.commandOrchestrator,
      {
        operation: JournalOperationType.Merge,
        repositoryId: this.repositoryId,
        correlationId: this.correlationId,
        input: { targetBranch },
        run: () => this.mergeEngine.merge(this.repositoryId, this.correlationId, targetBranch, signal),
      },
      describeMergeOutcome,
    );
  }
}
