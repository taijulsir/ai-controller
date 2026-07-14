export class ControllerEntryPointNotBoundError extends Error {
  constructor() {
    super("DeferredControllerCore.execute() was called before bind() wired it to the real entry point.");
    this.name = "ControllerEntryPointNotBoundError";
  }
}
