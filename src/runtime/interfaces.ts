import type { BackgroundRuntimeStatus } from "./types";

// A long-lived unit of background work the runtime hosts. Each worker owns
// its own execution cadence internally (a timer, a poll loop, ...) — there is
// no shared IScheduler: cadence is worker-specific policy, not something a
// generic runtime should have an opinion on. start()/stop() must be
// idempotent: calling either twice in a row is a no-op, not an error, since
// BackgroundRuntime may call stop() on a worker that never started.
//
// Deliberately left unchanged by Phase 8.5: a generic getStatus() was not
// added here, since its return shape would necessarily differ per concrete
// worker type (MonitoringWorker's status has nothing in common with some
// future, unrelated worker's). Status reporting for a specific worker is
// that worker's own concrete, additive public method — see MonitoringWorker.
export interface IBackgroundWorker {
  readonly id: string;
  start(): void;
  stop(): void;
}

// The composition root's single lifecycle handle for every IBackgroundWorker
// in the process. It manages worker lifecycle only — starting and stopping
// the fixed set of workers it was constructed with — and has no scheduling
// policy, execution capability, or transport awareness of its own.
export interface IBackgroundRuntime {
  start(): void;
  stop(): void;
  getStatus(): BackgroundRuntimeStatus;
  // Phase 8.6: resets whatever accumulated statistics this class holds —
  // never lifecycle state (running/startedAt/per-worker running flags are
  // untouched), and never a worker's own start()/stop().
  resetStatistics(): void;
}
