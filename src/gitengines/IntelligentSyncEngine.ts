import { GitAdapter } from "../git/GitAdapter";
import type { IGitTransactionManager } from "../gittransaction/interfaces";
import type { IApprovalGate, IAutomaticSafetyPolicies } from "../gitorchestration/interfaces";
import { DivergenceStrategy } from "../gitorchestration/types";
import { JournalOperationType } from "../journal/types";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import type { IIntelligentSyncEngine, IMergeEngine, IRebaseEngine } from "./interfaces";
import type { SyncOutcome } from "./types";

// Supersedes SyncWorkflow. On divergence, instead of refusing (today's
// DivergedBranchError), consults Automatic Safety Policies for the
// configured strategy and hands off to Rebase or Merge Engine -- the direct
// fix for the approved review's problems 1 and 3. Still fast-forwards
// trivially when possible; the added intelligence only activates on genuine
// divergence.
export class IntelligentSyncEngine implements IIntelligentSyncEngine {
  constructor(
    private readonly repositoryRegistry: IRepositoryRegistry,
    private readonly transactionManager: IGitTransactionManager,
    private readonly safetyPolicies: IAutomaticSafetyPolicies,
    private readonly approvalGate: IApprovalGate,
    private readonly rebaseEngine: IRebaseEngine,
    private readonly mergeEngine: IMergeEngine,
  ) {}

  async sync(repositoryId: string, correlationId: string, signal: AbortSignal): Promise<SyncOutcome> {
    const gitAdapter = new GitAdapter(this.repositoryRegistry, repositoryId);
    await gitAdapter.fetch();

    const upstreamRef = await gitAdapter.upstreamRef();
    if (!upstreamRef) {
      return { kind: "up-to-date" };
    }

    const alreadyUpToDate = await gitAdapter.isAncestor(upstreamRef, "HEAD");
    if (alreadyUpToDate) {
      return { kind: "up-to-date" };
    }

    const canFastForward = await gitAdapter.isAncestor("HEAD", upstreamRef);
    if (canFastForward) {
      const transaction = await this.transactionManager.begin({
        operation: JournalOperationType.Sync,
        repositoryId,
        correlationId,
        rollbackStrategy: "reset-hard",
        metadata: { upstreamRef },
      });
      await gitAdapter.fastForward(upstreamRef);
      await transaction.commit(await gitAdapter.headSha());
      return { kind: "fast-forwarded", toRef: upstreamRef };
    }

    // Diverged -- delegate per the configured strategy rather than refusing.
    // Every branch below rewrites or merges local history, so every branch
    // requests approval first -- the Ask strategy's own prompt already did
    // this explicitly; Merge and Rebase (including Rebase-as-default) must
    // too, rather than delegating straight to the Engine. Without this,
    // rebase's approval floor (AutomaticSafetyPolicies.HARDCODED_APPROVAL_OPERATIONS)
    // -- which this class's own doc comment already claimed covered "a
    // direct /rebase or a /sync delegating to it" -- was silently skippable
    // by simply going through /sync instead of /rebase directly, since this
    // delegated call never passed through Command Orchestrator/Automatic
    // Safety Policies at all.
    const strategy = this.safetyPolicies.divergenceStrategy(repositoryId);
    if (strategy === DivergenceStrategy.Ask) {
      const proceed = await this.approvalGate.requestApproval({
        correlationId,
        summary: "Branch has diverged from its upstream",
        detail: `Local and "${upstreamRef}" have both moved. Approve to reconcile via rebase, or reject to leave the branch as-is.`,
      });
      if (!proceed) {
        return { kind: "declined" };
      }
      const outcome = await this.rebaseEngine.rebase(repositoryId, correlationId, upstreamRef, signal);
      return { kind: "delegated", to: "rebase", outcome };
    }

    if (strategy === DivergenceStrategy.Merge) {
      const proceed = await this.approvalGate.requestApproval({
        correlationId,
        summary: "Branch has diverged from its upstream",
        detail: `Local and "${upstreamRef}" have both moved. This will merge "${upstreamRef}" to reconcile.`,
      });
      if (!proceed) {
        return { kind: "declined" };
      }
      const outcome = await this.mergeEngine.merge(repositoryId, correlationId, upstreamRef, signal);
      return { kind: "delegated", to: "merge", outcome };
    }

    const proceed = await this.approvalGate.requestApproval({
      correlationId,
      summary: "Branch has diverged from its upstream",
      detail: `Local and "${upstreamRef}" have both moved. This will rebase onto "${upstreamRef}" to reconcile.`,
    });
    if (!proceed) {
      return { kind: "declined" };
    }
    const outcome = await this.rebaseEngine.rebase(repositoryId, correlationId, upstreamRef, signal);
    return { kind: "delegated", to: "rebase", outcome };
  }
}
