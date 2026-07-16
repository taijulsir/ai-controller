export class RuntimeAdministrationServiceNotBoundError extends Error {
  constructor() {
    super(
      "DeferredRuntimeAdministrationService method was called before bind() wired it to the real RuntimeAdministrationService.",
    );
    this.name = "RuntimeAdministrationServiceNotBoundError";
  }
}
