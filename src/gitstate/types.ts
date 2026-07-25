// Completes the approved review's Fig. 3 (an illustrative subset) with the
// full set implied by the Repository Health Model's in-progress-operation
// dimensions -- cherry-pick/revert/bisect join merge/rebase as first-class
// states, not folded into a generic "busy" value.
export enum RepositoryState {
  Clean = "clean",
  Dirty = "dirty",
  Diverged = "diverged",
  MergeInProgress = "merge-in-progress",
  RebaseInProgress = "rebase-in-progress",
  CherryPickInProgress = "cherry-pick-in-progress",
  RevertInProgress = "revert-in-progress",
  BisectInProgress = "bisect-in-progress",
  DetachedHead = "detached-head",
  Recovering = "recovering",
  Unrecoverable = "unrecoverable",
}
