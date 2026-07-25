import type { IGitAdapter } from "../../git/interfaces";
import type { IRebaseEngine } from "../../gitengines/interfaces";
import type { ICommandOrchestrator } from "../../gitorchestration/interfaces";
import { JournalOperationType } from "../../journal/types";
import { NoUpstreamConfiguredError } from "../errors";
import type { ITaskWorkflow } from "../interfaces";
import type { RebaseTask, Task, WorkflowResult } from "../types";
import { describeRebaseOutcome, runGated } from "./gitOrchestrationSupport";

// New command (/rebase), not a retrofit of an existing one. A bare
// "/rebase" (no argument) defaults to the branch's own configured upstream,
// the same target SyncWorkflow's "@{upstream}" shorthand always resolves
// to -- an explicit ref is only needed to rebase onto something else.
export class RebaseWorkflow implements ITaskWorkflow {
  constructor(
    private readonly gitAdapter: IGitAdapter,
    private readonly commandOrchestrator: ICommandOrchestrator,
    private readonly rebaseEngine: IRebaseEngine,
    private readonly repositoryId: string,
    private readonly correlationId: string,
  ) {}

  async execute(task: Task, signal: AbortSignal): Promise<WorkflowResult> {
    const { input } = task as RebaseTask;
    const ontoRef = input?.onto ?? (await this.gitAdapter.upstreamRef());
    if (!ontoRef) {
      const branch = await this.gitAdapter.currentBranch();
      throw new NoUpstreamConfiguredError(branch);
    }

    return runGated(
      this.commandOrchestrator,
      {
        operation: JournalOperationType.Rebase,
        repositoryId: this.repositoryId,
        correlationId: this.correlationId,
        input: { onto: ontoRef },
        run: () => this.rebaseEngine.rebase(this.repositoryId, this.correlationId, ontoRef, signal),
      },
      describeRebaseOutcome,
    );
  }
}
