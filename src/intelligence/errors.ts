export class NoActiveRepositoryError extends Error {
  constructor() {
    super(
      "No active repository is set. Call setActiveRepository() on the registry first, or pass an explicit repository id to getSnapshot().",
    );
    this.name = "NoActiveRepositoryError";
  }
}
