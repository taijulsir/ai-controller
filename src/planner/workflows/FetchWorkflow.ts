import type { IGitAdapter } from "../../git/interfaces";
import type { ICommandOrchestrator } from "../../gitorchestration/interfaces";
import { JournalOperationType } from "../../journal/types";
import type { ITaskWorkflow } from "../interfaces";
import type { Task, WorkflowResult } from "../types";
import { runGated } from "./gitOrchestrationSupport";

// Routed through Command Orchestrator for consistency with every other git
// command, but never opens an IGitTransactionManager Transaction and is
// never journaled: fetch only updates remote-tracking refs, never the
// working tree, the index, or the current branch -- there is nothing to
// roll back and nothing for Safe Undo Framework to reverse. Automatic
// Safety Policies deliberately exempts fetch from the in-progress-operation
// recommend-recovery short-circuit for the same reason (see its own
// comment): fetch is safe to run even mid-merge/mid-rebase.
export class FetchWorkflow implements ITaskWorkflow {
  constructor(
    private readonly gitAdapter: IGitAdapter,
    private readonly commandOrchestrator: ICommandOrchestrator,
    private readonly repositoryId: string,
    private readonly correlationId: string,
  ) {}

  async execute(_task: Task, _signal: AbortSignal): Promise<WorkflowResult> {
    return runGated(
      this.commandOrchestrator,
      {
        operation: JournalOperationType.Fetch,
        repositoryId: this.repositoryId,
        correlationId: this.correlationId,
        run: async () => {
          await this.gitAdapter.fetch();
          const status = await this.gitAdapter.status();
          return `Fetched. "${status.branch}" is now ${status.ahead} ahead, ${status.behind} behind its upstream.`;
        },
      },
      (message) => message,
    );
  }
}
