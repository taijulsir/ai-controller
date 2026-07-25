import { GitOrchestrationError } from "../gitstate/errors";

export class UnresolvedConflictError extends GitOrchestrationError {
  constructor(public readonly files: string[]) {
    super(`${files.length} file(s) still conflicted: ${files.join(", ")}`);
    this.name = "UnresolvedConflictError";
  }
}

export class RebaseInProgressError extends GitOrchestrationError {
  constructor() {
    super("A rebase is already in progress -- resolve, /resume, or /abort it first.");
    this.name = "RebaseInProgressError";
  }
}

export class MergeInProgressError extends GitOrchestrationError {
  constructor() {
    super("A merge is already in progress -- resolve, /resume, or /abort it first.");
    this.name = "MergeInProgressError";
  }
}

export class UnrelatedHistoriesError extends GitOrchestrationError {
  constructor(public readonly targetBranch: string) {
    super(`"${targetBranch}" shares no common history with the current branch.`);
    this.name = "UnrelatedHistoriesError";
  }
}
