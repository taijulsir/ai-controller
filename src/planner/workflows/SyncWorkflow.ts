import type { IIntelligentSyncEngine } from "../../gitengines/interfaces";
import type { ICommandOrchestrator } from "../../gitorchestration/interfaces";
import { JournalOperationType } from "../../journal/types";
import type { ITaskWorkflow } from "../interfaces";
import type { Task, WorkflowResult } from "../types";
import { describeSyncOutcome, runGated } from "./gitOrchestrationSupport";

// Supersedes the old fast-forward-only SyncWorkflow: safety preconditions
// (detached HEAD, dirty tree) are now Pre-flight Validation Policy's job,
// enforced uniformly by Command Orchestrator before run() is ever called,
// so this class no longer duplicates them (DetachedHeadError/
// UnsafeGitOperationError/DivergedBranchError are gone -- see
// PreflightValidationFailedError instead). On genuine divergence, delegates
// to Intelligent Sync Engine, which itself consults Automatic Safety
// Policies' configured divergence strategy (rebase/merge/ask) instead of
// refusing outright -- the direct fix for the approved review's problems 1
// and 3 (DivergedBranchError forced a manual /merge before).
export class SyncWorkflow implements ITaskWorkflow {
  constructor(
    private readonly commandOrchestrator: ICommandOrchestrator,
    private readonly syncEngine: IIntelligentSyncEngine,
    private readonly repositoryId: string,
    private readonly correlationId: string,
  ) {}

  async execute(_task: Task, signal: AbortSignal): Promise<WorkflowResult> {
    return runGated(
      this.commandOrchestrator,
      {
        operation: JournalOperationType.Sync,
        repositoryId: this.repositoryId,
        correlationId: this.correlationId,
        run: () => this.syncEngine.sync(this.repositoryId, this.correlationId, signal),
      },
      describeSyncOutcome,
    );
  }
}
