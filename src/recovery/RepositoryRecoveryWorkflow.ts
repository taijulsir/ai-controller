import { rm } from "node:fs/promises";
import path from "node:path";
import { GitAdapter } from "../git/GitAdapter";
import type { IGitHealthService } from "../git/interfaces";
import type { IApprovalGate } from "../gitorchestration/interfaces";
import type { IRepositoryStateAnalyzer } from "../gitstate/interfaces";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import { RecoveryPlanStaleError } from "./errors";
import type { IRepositoryRecoveryWorkflow } from "./interfaces";
import type { RecoveryOutcome, RecoveryPlan, RecoveryStep } from "./types";

// Turns a RecoveryPlan into an interactive, step-by-step execution --
// directly closes the approved review's problem 6 (no guided recovery from
// Human Review Required). Re-validates against live health before running
// (reValidateBeforeExecution is always true on the type itself, per §9.5 of
// the review: a plan is never trusted as still-accurate from when it was
// generated).
export class RepositoryRecoveryWorkflow implements IRepositoryRecoveryWorkflow {
  constructor(
    private readonly repositoryRegistry: IRepositoryRegistry,
    private readonly healthService: IGitHealthService,
    private readonly stateAnalyzer: IRepositoryStateAnalyzer,
    private readonly approvalGate: IApprovalGate,
  ) {}

  async execute(plan: RecoveryPlan, _signal: AbortSignal): Promise<RecoveryOutcome> {
    const liveReport = await this.healthService.getHealth(plan.repositoryId);
    const liveState = this.stateAnalyzer.classify(liveReport);
    if (liveState !== plan.detectedState) {
      throw new RecoveryPlanStaleError(plan.id);
    }

    const gitAdapter = new GitAdapter(this.repositoryRegistry, plan.repositoryId);
    const completedSteps: string[] = [];

    for (const step of plan.steps) {
      if (step.requiresApproval) {
        const approved = await this.approvalGate.requestApproval({
          correlationId: plan.repositoryId,
          summary: step.description,
          detail: `Recovery step for repository "${plan.repositoryId}" (detected state: ${plan.detectedState}).`,
        });
        if (!approved) {
          const finalReport = await this.healthService.getHealth(plan.repositoryId);
          return {
            planId: plan.id,
            completedSteps,
            stoppedAtStep: step.id,
            finalState: this.stateAnalyzer.classify(finalReport),
          };
        }
      }

      await this.runStep(gitAdapter, step);
      completedSteps.push(step.id);
    }

    const finalReport = await this.healthService.getHealth(plan.repositoryId);
    return { planId: plan.id, completedSteps, stoppedAtStep: undefined, finalState: this.stateAnalyzer.classify(finalReport) };
  }

  private async runStep(gitAdapter: GitAdapter, step: RecoveryStep): Promise<void> {
    switch (step.command.kind) {
      case "abort-merge":
        return gitAdapter.abortMerge();
      case "abort-rebase":
        return gitAdapter.abortRebase();
      case "abort-cherry-pick":
        return gitAdapter.abortCherryPick();
      case "abort-revert":
        return gitAdapter.abortRevert();
      case "abort-bisect":
        return gitAdapter.abortBisect();
      case "discard-working-tree":
        await gitAdapter.resetHard(await gitAdapter.headSha());
        return gitAdapter.cleanWorkingTree();
      case "remove-stale-lock": {
        const gitDir = await gitAdapter.gitDir();
        await rm(path.join(gitDir, step.command.lockPath), { force: true });
        return;
      }
      case "create-branch-at-head": {
        const headSha = await gitAdapter.headSha();
        return gitAdapter.createBranch(`recovered-${headSha.slice(0, 12)}`);
      }
      case "resolve-conflict":
      case "recommend-reclone":
      case "resync":
        // Advisory-only commands -- deliberately no automatic action. A
        // conflict resolution mode is chosen by the caller of
        // ConflictResolutionEngine directly, not replayed generically here;
        // reclone/resync are operator actions this workflow only surfaces,
        // never performs (recloning in particular is explicitly "never
        // automatic" per the approved review's Recovery Engine table).
        return;
    }
  }
}
