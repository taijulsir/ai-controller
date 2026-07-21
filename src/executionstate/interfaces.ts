import type { CurrentTaskSnapshot } from "./types";

// Read-only view over ExecutionStateTracker -- the only capability given to
// ApplicationService or any other consumer that only needs to answer "what's
// running". Nothing depending on this interface can start, end, or otherwise
// mutate tracked execution state; only ExecutionStateTracker itself (via its
// separate IControllerCore role) does that.
export interface IExecutionStateReader {
  // Keyed by repositoryId, matching the same repository resolution
  // convention every other ApplicationService query already follows.
  // undefined when no execution is currently tracked for this repository.
  //
  // ExecutionStateTracker's internal model is keyed by repositoryId (one
  // independent record per repository), so this already supports several
  // repositories executing concurrently -- this signature stays "one
  // repository in, one snapshot or undefined out" without assuming only one
  // execution can ever exist system-wide.
  getCurrent(repositoryId: string): CurrentTaskSnapshot | undefined;
}
