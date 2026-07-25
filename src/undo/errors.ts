import { GitOrchestrationError } from "../gitstate/errors";

export class CannotExecuteUndoPlanError extends Error {
  constructor(status: string) {
    super(`executeUndoPlan() was called with a plan whose status is "${status}", not "ready".`);
    this.name = "CannotExecuteUndoPlanError";
  }
}

export class AlreadyPushedError extends GitOrchestrationError {
  constructor(public readonly journalEntryId: string) {
    super(
      "This operation was already pushed to a shared remote -- undoing it requires explicit " +
        "approval and will produce a revert commit, not a history rewrite.",
    );
    this.name = "AlreadyPushedError";
  }
}

export class NothingToUndoError extends Error {
  constructor() {
    super("Nothing to undo -- no completed git-native operation was found for this repository.");
    this.name = "NothingToUndoError";
  }
}
