import { randomUUID } from "node:crypto";
import type { RepositoryHealthReport } from "../git/types";
import type { IRepositoryStateAnalyzer } from "../gitstate/interfaces";
import { RepositoryState } from "../gitstate/types";
import type { IRecoveryPlanner } from "./interfaces";
import { RecoveryStepRisk, type RecoveryPlan, type RecoveryStep } from "./types";

// States that represent normal operation, not something to recover from --
// their own direct commands (/commit, /discard, /sync) already handle them.
const NO_PLAN_STATES: ReadonlySet<RepositoryState> = new Set([RepositoryState.Clean, RepositoryState.Dirty, RepositoryState.Diverged]);

// Given a RepositoryHealthReport in any non-Clean state, produces an
// ordered, human-readable RecoveryPlan: a sequence of specific, safe next
// actions (never raw git commands) with each step's own risk
// classification. Pure planning -- never executes anything itself, matching
// the existing PlanningEngine/ExecutionCoordinator split.
export class RecoveryPlanner implements IRecoveryPlanner {
  constructor(private readonly stateAnalyzer: IRepositoryStateAnalyzer) {}

  plan(report: RepositoryHealthReport): RecoveryPlan | undefined {
    const state = this.stateAnalyzer.classify(report);
    if (NO_PLAN_STATES.has(state)) {
      return undefined;
    }

    const steps = this.buildSteps(state, report);
    return {
      id: randomUUID(),
      repositoryId: report.repositoryId,
      createdAt: new Date(),
      detectedState: state,
      summary: this.summaryFor(state, report),
      steps,
      reValidateBeforeExecution: true,
    };
  }

  private buildSteps(state: RepositoryState, report: RepositoryHealthReport): RecoveryStep[] {
    const steps: RecoveryStep[] = [];

    if (report.locks.staleLockDetected) {
      steps.push({
        id: randomUUID(),
        description: "Remove the stale git lock file left by an interrupted process.",
        risk: RecoveryStepRisk.Irreversible,
        requiresApproval: true,
        command: { kind: "remove-stale-lock", lockPath: report.locks.indexLocked ? "index.lock" : "HEAD.lock" },
      });
    }

    switch (state) {
      case RepositoryState.MergeInProgress:
        steps.push(this.abortStep("abort-merge", "Abort the in-progress merge and restore the pre-merge state."));
        break;
      case RepositoryState.RebaseInProgress:
        steps.push(this.abortStep("abort-rebase", "Abort the in-progress rebase and restore the pre-rebase state."));
        break;
      case RepositoryState.CherryPickInProgress:
        steps.push(this.abortStep("abort-cherry-pick", "Abort the in-progress cherry-pick."));
        break;
      case RepositoryState.RevertInProgress:
        steps.push(this.abortStep("abort-revert", "Abort the in-progress revert."));
        break;
      case RepositoryState.BisectInProgress:
        steps.push(this.abortStep("abort-bisect", "Reset the in-progress bisect session."));
        break;
      case RepositoryState.DetachedHead:
        steps.push({
          id: randomUUID(),
          description: "Create a branch at the current (detached) commit so it isn't orphaned on the next checkout.",
          risk: RecoveryStepRisk.Safe,
          requiresApproval: false,
          command: { kind: "create-branch-at-head" },
        });
        break;
      case RepositoryState.Recovering:
        if (report.interruptedOperation) {
          steps.push(this.abortStepForKind(report.interruptedOperation.kind));
        }
        break;
      case RepositoryState.Unrecoverable:
        steps.push({
          id: randomUUID(),
          description: "This repository's state cannot be repaired automatically -- back up any local work and re-clone.",
          risk: RecoveryStepRisk.Irreversible,
          requiresApproval: true,
          command: { kind: "recommend-reclone" },
        });
        break;
      default:
        break;
    }

    return steps;
  }

  private abortStepForKind(kind: string): RecoveryStep {
    switch (kind) {
      case "rebase":
        return this.abortStep("abort-rebase", "Abort the interrupted rebase and restore the pre-rebase state.");
      case "cherry-pick":
        return this.abortStep("abort-cherry-pick", "Abort the interrupted cherry-pick.");
      case "revert":
        return this.abortStep("abort-revert", "Abort the interrupted revert.");
      case "bisect":
        return this.abortStep("abort-bisect", "Reset the interrupted bisect session.");
      default:
        return this.abortStep("abort-merge", "Abort the interrupted merge and restore the pre-merge state.");
    }
  }

  private abortStep(
    kind: "abort-merge" | "abort-rebase" | "abort-cherry-pick" | "abort-revert" | "abort-bisect",
    description: string,
  ): RecoveryStep {
    return {
      id: randomUUID(),
      description,
      // git's own abort primitives are atomic and restore exactly the
      // pre-operation state -- never destructive to already-committed work.
      risk: RecoveryStepRisk.Safe,
      requiresApproval: false,
      command: { kind },
    };
  }

  private summaryFor(state: RepositoryState, report: RepositoryHealthReport): string {
    if (report.locks.staleLockDetected) {
      return `Repository is in "${state}" with a stale lock file left behind -- likely an interrupted operation.`;
    }
    return `Repository is in "${state}".`;
  }
}
