export class RuntimeStatusServiceNotBoundError extends Error {
  constructor() {
    super(
      "DeferredRuntimeStatusService.getStatus() was called before bind() wired it to the real RuntimeStatusService.",
    );
    this.name = "RuntimeStatusServiceNotBoundError";
  }
}
