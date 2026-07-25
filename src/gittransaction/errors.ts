import { GitOrchestrationError } from "../gitstate/errors";

export class TransactionAlreadyCommittedError extends GitOrchestrationError {
  constructor(public readonly journalEntryId: string) {
    super(`Transaction ${journalEntryId} was already committed and cannot be rolled back`);
    this.name = "TransactionAlreadyCommittedError";
  }
}

export class TransactionRollbackFailedError extends GitOrchestrationError {
  constructor(
    public readonly journalEntryId: string,
    public readonly cause: string,
  ) {
    super(`Rollback failed for transaction ${journalEntryId}: ${cause}`);
    this.name = "TransactionRollbackFailedError";
  }
}
