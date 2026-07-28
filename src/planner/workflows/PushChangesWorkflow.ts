import type { IGitAdapter } from "../../git/interfaces";
import type { PushResult } from "../../git/types";
import { buildGithubTreeUrl } from "../../github/GithubUrl";
import type { ICommandOrchestrator } from "../../gitorchestration/interfaces";
import type { IOperationJournal } from "../../journal/interfaces";
import { JournalEntryStatus, JournalOperationType } from "../../journal/types";
import type { ITaskWorkflow } from "../interfaces";
import type { Task, WorkflowResult } from "../types";
import { runGated } from "./gitOrchestrationSupport";

// Commit and Push Result Messages: caps how many commits buildPushResult
// itself fetches for a single push's "Pushed Commits" list -- ResponseFormatter
// is the one that further truncates how many are actually *displayed* (same
// "fetch everything reasonable, truncate at render time" split
// /showchanges' own diff line cap already uses), this just bounds the git
// call itself against a pathological push of thousands of commits at once.
const MAX_PUSHED_COMMITS_FETCHED = 100;

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
    // Set by the `run` callback below on success, read back after runGated
    // resolves -- see CreateCommitWorkflow's identical use of this shape.
    let pushCompleted: PushResult | undefined;

    const result = await runGated(
      this.commandOrchestrator,
      {
        operation: JournalOperationType.Push,
        repositoryId: this.repositoryId,
        correlationId: this.correlationId,
        run: async () => {
          const ref = await this.gitAdapter.headSha();
          // Resolved *before* push() runs: push moves the local
          // remote-tracking ref forward, so this is genuinely the upstream's
          // tip as it was before this push -- undefined when no upstream is
          // configured yet (a branch's very first push).
          const previousUpstreamSha = await this.gitAdapter.upstreamSha();
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
          pushCompleted = await this.buildPushResult(ref, previousUpstreamSha);
        },
      },
      () => undefined,
    );

    return { ...result, pushCompleted };
  }

  // Composed once, right after a successful push -- everything
  // ResponseFormatter needs to render "✅ Push Successful" without a second
  // round trip to git. The range between previousUpstreamSha and headSha is
  // exactly what this push newly published; when no upstream existed yet
  // (first push of a new branch), there is no earlier remote tip to diff
  // against, so reporting just the single HEAD commit as "pushed" is a
  // known, deliberate simplification -- not an attempt to walk the branch's
  // entire history looking for what's genuinely new to the remote.
  private async buildPushResult(headSha: string, previousUpstreamSha: string | undefined): Promise<PushResult> {
    const [branch, status, metadata, remoteUrl] = await Promise.all([
      this.gitAdapter.currentBranch(),
      this.gitAdapter.status(),
      this.gitAdapter.getCommitMetadata(headSha),
      this.gitAdapter.remoteUrl("origin"),
    ]);

    const pushedCommits =
      previousUpstreamSha === headSha
        ? []
        : previousUpstreamSha
          ? await this.gitAdapter.getCommitHistory(MAX_PUSHED_COMMITS_FETCHED, `${previousUpstreamSha}..${headSha}`)
          : await this.gitAdapter.getCommitHistory(1, headSha);

    return {
      branch,
      remote: "origin",
      headSha,
      headShortSha: metadata.shortSha,
      headMessage: metadata.body,
      pushedCommits,
      ahead: status.ahead,
      behind: status.behind,
      githubUrl: remoteUrl ? buildGithubTreeUrl(remoteUrl, branch) : undefined,
      timestamp: new Date(),
    };
  }
}
