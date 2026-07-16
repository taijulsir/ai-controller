export class RuntimeControlServiceNotBoundError extends Error {
  constructor() {
    super(
      "DeferredRuntimeControlService method was called before bind() wired it to the real RuntimeControlService.",
    );
    this.name = "RuntimeControlServiceNotBoundError";
  }
}
