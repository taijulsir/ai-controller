export class CannotExecuteUndoPlanError extends Error {
  constructor(status: string) {
    super(`executeUndoPlan() was called with a plan whose status is "${status}", not "ready".`);
    this.name = "CannotExecuteUndoPlanError";
  }
}
