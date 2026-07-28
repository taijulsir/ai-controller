import type { IGitAdapter } from "../../git/interfaces";
import type { CommitCreationResult } from "../../git/types";
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

    // Set by the `run` callback below on success, read back after runGated
    // resolves -- runGated's own generic `describe()` hook only ever
    // produces a plain string for WorkflowResult.output, not the richer
    // structured summary Commit and Push Result Messages needs.
    let commitCreated: CommitCreationResult | undefined;

    const result = await runGated(
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
          let sha: string;
          try {
            await this.gitAdapter.stageAll();
            await this.gitAdapter.commit(message);
            sha = await this.gitAdapter.headSha();
          } catch (error) {
            await transaction.rollback();
            throw error;
          }
          await transaction.commit(sha);
          commitCreated = await this.buildCommitCreationResult(sha, message);
        },
      },
      () => undefined,
    );

    return { ...result, commitCreated };
  }

  // Composed once, right after a successful commit -- everything
  // ResponseFormatter needs to render "✅ Commit Created" without a second
  // round trip to git. `message` is passed straight through from the task
  // input rather than re-read via git log: it's the exact string just
  // committed. Deliberately no GitHub URL here (unlike PushChangesWorkflow's
  // own result) -- a commit that only exists locally has nothing to link to
  // on GitHub until it's pushed.
  private async buildCommitCreationResult(sha: string, message: string): Promise<CommitCreationResult> {
    const [branch, files, diffStats, metadata] = await Promise.all([
      this.gitAdapter.currentBranch(),
      this.gitAdapter.getCommitFileChanges(sha),
      this.gitAdapter.getCommitDiffStat(sha),
      this.gitAdapter.getCommitMetadata(sha),
    ]);
    const { insertions, deletions } = diffStats.reduce(
      (totals, stat) => ({ insertions: totals.insertions + stat.insertions, deletions: totals.deletions + stat.deletions }),
      { insertions: 0, deletions: 0 },
    );

    return {
      branch,
      sha,
      shortSha: metadata.shortSha,
      message,
      files,
      filesChanged: files.length,
      insertions,
      deletions,
      timestamp: new Date(),
    };
  }
}
