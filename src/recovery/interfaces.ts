import type { RepositoryHealthReport } from "../git/types";
import type { RecoveryOutcome, RecoveryPlan } from "./types";

export interface IRecoveryPlanner {
  // undefined when the report classifies as RepositoryState.Clean or Dirty
  // or Diverged -- those are normal operating states with their own direct
  // commands (/commit, /discard, /sync), not something requiring a recovery
  // plan.
  plan(report: RepositoryHealthReport): RecoveryPlan | undefined;
}

export interface IRepositoryRecoveryWorkflow {
  execute(plan: RecoveryPlan, signal: AbortSignal): Promise<RecoveryOutcome>;
}
