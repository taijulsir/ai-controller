import { RepositoryState } from "./types";

// Base for every named, anticipated failure the git orchestration
// architecture introduces -- deliberately distinct from GitCommandError
// (src/git/errors.ts), which stays the passthrough for raw git failures
// nothing anticipated. See the Phase 0 freeze, §5 (Error hierarchy).
export abstract class GitOrchestrationError extends Error {}

export class IllegalStateTransitionError extends GitOrchestrationError {
  constructor(
    public readonly from: RepositoryState,
    public readonly to: RepositoryState,
  ) {
    super(`Illegal repository state transition: ${from} -> ${to}`);
    this.name = "IllegalStateTransitionError";
  }
}
