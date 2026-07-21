export class ExecutionStateReaderNotBoundError extends Error {
  constructor() {
    super(
      "DeferredExecutionStateReader.getCurrent() was called before bind() wired it to the real ExecutionStateTracker.",
    );
    this.name = "ExecutionStateReaderNotBoundError";
  }
}
