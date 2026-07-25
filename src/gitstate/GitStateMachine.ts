import { IllegalStateTransitionError } from "./errors";
import type { IGitStateMachine } from "./interfaces";
import { RepositoryState } from "./types";

// The frozen transition table from Phase 0, §10 -- data, not scattered
// conditionals, so canTransition()/legalNextStates() can never drift from
// Fig. 3. Recovering is the only state with a legal path to Unrecoverable;
// Unrecoverable itself is terminal (escalate to a human, never auto-retry).
const LEGAL_TRANSITIONS: ReadonlyMap<RepositoryState, ReadonlySet<RepositoryState>> = new Map<
  RepositoryState,
  ReadonlySet<RepositoryState>
>([
  [
    RepositoryState.Clean,
    new Set([
      RepositoryState.Dirty,
      RepositoryState.Diverged,
      RepositoryState.MergeInProgress,
      RepositoryState.RebaseInProgress,
      RepositoryState.CherryPickInProgress,
      RepositoryState.RevertInProgress,
      RepositoryState.BisectInProgress,
      RepositoryState.DetachedHead,
      RepositoryState.Recovering,
    ]),
  ],
  [RepositoryState.Dirty, new Set([RepositoryState.Clean])],
  [RepositoryState.Diverged, new Set([RepositoryState.Clean])],
  [RepositoryState.MergeInProgress, new Set([RepositoryState.Clean, RepositoryState.Recovering])],
  [RepositoryState.RebaseInProgress, new Set([RepositoryState.Clean, RepositoryState.Recovering])],
  [RepositoryState.CherryPickInProgress, new Set([RepositoryState.Clean, RepositoryState.Recovering])],
  [RepositoryState.RevertInProgress, new Set([RepositoryState.Clean, RepositoryState.Recovering])],
  [RepositoryState.BisectInProgress, new Set([RepositoryState.Clean, RepositoryState.Recovering])],
  [RepositoryState.DetachedHead, new Set([RepositoryState.Clean])],
  [RepositoryState.Recovering, new Set([RepositoryState.Clean, RepositoryState.Unrecoverable])],
  [RepositoryState.Unrecoverable, new Set([])],
]);

export class GitStateMachine implements IGitStateMachine {
  canTransition(from: RepositoryState, to: RepositoryState): boolean {
    return LEGAL_TRANSITIONS.get(from)?.has(to) ?? false;
  }

  legalNextStates(from: RepositoryState): RepositoryState[] {
    return [...(LEGAL_TRANSITIONS.get(from) ?? [])];
  }

  // A stricter sibling to canTransition() for the one caller (Command
  // Orchestrator) that must fail loudly rather than silently ignore an
  // illegal transition.
  assertTransition(from: RepositoryState, to: RepositoryState): void {
    if (!this.canTransition(from, to)) {
      throw new IllegalStateTransitionError(from, to);
    }
  }
}
