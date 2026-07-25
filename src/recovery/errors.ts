import { GitOrchestrationError } from "../gitstate/errors";
import type { RepositoryState } from "../gitstate/types";

export class UnrecoverableStateError extends GitOrchestrationError {
  constructor(
    public readonly detectedState: RepositoryState,
    public readonly reason: string,
  ) {
    super(`Repository state "${detectedState}" cannot be recovered automatically: ${reason}`);
    this.name = "UnrecoverableStateError";
  }
}

export class RecoveryPlanStaleError extends GitOrchestrationError {
  constructor(public readonly planId: string) {
    super(`Recovery plan ${planId} no longer matches the repository's current state -- re-run /recover.`);
    this.name = "RecoveryPlanStaleError";
  }
}
