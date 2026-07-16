import { RuntimeAlreadyStartedError } from "./errors";
import type { IBackgroundRuntime, IBackgroundWorker } from "./interfaces";
import type { BackgroundRuntimeStatus } from "./types";

// Arbitrary and inert: this handle's callback never needs to run, it only
// needs to exist. Kept well under Node/V8's ~24.8-day (2^31-1 ms) signed
// 32-bit timer ceiling, past which a timer fires immediately instead of
// waiting — 24h is a conventional, safe "effectively forever" choice.
const KEEP_ALIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Manages worker lifecycle only: which workers exist is fixed at
// construction, and start()/stop() just start/stop all of them together. It
// never schedules any worker's cadence itself (each worker owns that) and
// never touches ControllerCore/ExecutionPipeline/any adapter directly — it
// has no dependency capable of any of that, by construction. A single
// worker's synchronous start()/stop() failure is logged and does not prevent
// the others from starting/stopping, since workers are independent of each
// other.
//
// Process liveness is a separate, explicit responsibility this class owns
// for itself, deliberately decoupled from whatever ref()/unref() choice any
// individual worker makes for its own internal timer. A worker like
// MonitoringWorker unref()s its own interval on purpose — it must never be
// the reason the process stays alive, since that's not its concern. Instead,
// BackgroundRuntime holds one dedicated, ref()'d, otherwise-inert interval
// for the duration it's running: while running, the process will not exit
// for lack of other pending work, regardless of which (if any) transport
// (e.g. Telegram) is enabled. This is what lets monitoring keep ticking even
// when no other long-lived operation (like Telegram's poll loop) is what
// would otherwise have kept Node alive.
export class BackgroundRuntime implements IBackgroundRuntime {
  private running = false;
  private keepAliveHandle?: NodeJS.Timeout;
  private startedAt?: Date;
  // Phase 8.5: tracks each worker's last known start()/stop() outcome, set
  // inside the exact same try/catch blocks start()/stop() already had —
  // purely additive bookkeeping, no change to what either method does.
  private readonly workerRunning = new Map<string, boolean>();

  constructor(private readonly workers: readonly IBackgroundWorker[]) {}

  start(): void {
    if (this.running) {
      throw new RuntimeAlreadyStartedError();
    }
    this.running = true;
    this.startedAt = new Date();
    this.keepAliveHandle = setInterval(() => {}, KEEP_ALIVE_INTERVAL_MS);

    for (const worker of this.workers) {
      try {
        worker.start();
        this.workerRunning.set(worker.id, true);
      } catch (error) {
        this.workerRunning.set(worker.id, false);
        console.error(
          `background-runtime: worker "${worker.id}" failed to start:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  // Safe to call even if start() was never called, or only partially
  // succeeded — every worker is asked to stop regardless of whether it
  // reported starting cleanly, and stop() is itself idempotent per worker.
  stop(): void {
    for (const worker of [...this.workers].reverse()) {
      try {
        worker.stop();
      } catch (error) {
        console.error(
          `background-runtime: worker "${worker.id}" failed to stop:`,
          error instanceof Error ? error.message : error,
        );
      } finally {
        this.workerRunning.set(worker.id, false);
      }
    }

    if (this.keepAliveHandle) {
      clearInterval(this.keepAliveHandle);
      this.keepAliveHandle = undefined;
    }
    this.running = false;
    this.startedAt = undefined;
  }

  // Read-only: reports state already tracked for its own start()/stop()
  // bookkeeping, plus a plain arithmetic uptime derivation — never calls
  // start(), stop(), or any worker method as a side effect of being asked.
  getStatus(): BackgroundRuntimeStatus {
    return {
      running: this.running,
      startedAt: this.startedAt,
      uptimeMs: this.running && this.startedAt ? Date.now() - this.startedAt.getTime() : undefined,
      workers: this.workers.map((worker) => ({ id: worker.id, running: this.workerRunning.get(worker.id) ?? false })),
    };
  }

  // Phase 8.6: deliberately a no-op today. running/startedAt/workerRunning
  // are all live lifecycle state, not accumulated statistics — there is
  // nothing here to reset without either fabricating a false running/stopped
  // state or corrupting real lifecycle tracking (which start()/stop() alone
  // must continue to own). This method exists so RuntimeControlService has a
  // stable, additive hook to call; if BackgroundRuntime ever gains genuine
  // accumulating counters in a future phase, this is where they would be
  // reset. It never calls start(), stop(), or touches running/startedAt/
  // workerRunning.
  resetStatistics(): void {}
}
