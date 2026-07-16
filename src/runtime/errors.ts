export class RuntimeAlreadyStartedError extends Error {
  constructor() {
    super("BackgroundRuntime.start() was called, but the runtime is already running. Call stop() first.");
    this.name = "RuntimeAlreadyStartedError";
  }
}
