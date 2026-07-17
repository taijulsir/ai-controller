import type { IAutonomousPlanCycleRecorder } from "../application/interfaces";
import type { IBackgroundWorker } from "./interfaces";

// Kept as an internal constant for now, matching MonitoringWorker's own
// DEFAULT_MONITORING_INTERVAL_MS precedent. Longer than monitoring's 15
// minutes deliberately: a recording cycle does a full repository fan-out
// (getRecommendations() per registered repository) plus a durable write,
// materially heavier than a single read-only health check.
const DEFAULT_RECORDING_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Phase 10.1: the first thing to continuously exercise the recorded-planning
// domain (Phases 9.2-10) against real data instead of only synthetic test
// fixtures. Owns its own execution cadence (a plain interval timer), same as
// MonitoringWorker — BackgroundRuntime only starts/stops this worker, it has
// no opinion on how often it ticks.
//
// Depends only on IAutonomousPlanCycleRecorder, not the full
// IApplicationService — the narrow view carved out specifically so this
// worker has no dependency capable of anything except triggering a
// recording, matching MonitoringWorker's own "no dependency capable of X, by
// construction" guarantee (it cannot reach getRuntimeControl(),
// getRuntimeAdministration(), or any other IApplicationService surface,
// because it never holds a reference capable of it). It performs exactly one
// action per tick and no more: call recordAutonomousPlanCycle(). No
// deduplication, no retention policy, no cadence gating beyond its own fixed
// interval — those remain a future phase's decision, exactly as the
// architecture review for this phase concluded.
export class AutonomousPlanRecordingWorker implements IBackgroundWorker {
  readonly id = "autonomous-plan-recording-worker";

  private intervalHandle?: NodeJS.Timeout;
  private ticking = false;
  // Phase 10.3: additive bookkeeping only, updated inside tick()'s existing
  // try/catch/finally — no change to tick()'s control flow, scheduling, or
  // outcome. lastSuccessfulCycleAt/lastRecordedCycleNumber are updated only
  // on a successful recording and are never cleared by a later failure —
  // they answer "how stale is the data" independently of "is the worker
  // currently failing." lastError reflects only the most recent tick: set on
  // failure, cleared on the next success — it answers "is this worker
  // healthy right now," not a running failure history.
  private lastSuccessfulCycleAt?: Date;
  private lastRecordedCycleNumber?: number;
  private lastError?: string;

  constructor(
    private readonly recorder: IAutonomousPlanCycleRecorder,
    private readonly intervalMs: number = DEFAULT_RECORDING_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.intervalHandle) {
      return;
    }
    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // unref()'d deliberately, same as MonitoringWorker's own timer: this
    // worker must never be the reason the process stays alive on its own —
    // BackgroundRuntime already holds one dedicated, ref()'d keep-alive
    // interval for that, independent of which workers exist.
    this.intervalHandle.unref?.();
  }

  stop(): void {
    if (!this.intervalHandle) {
      return;
    }
    clearInterval(this.intervalHandle);
    this.intervalHandle = undefined;
  }

  // Re-entrancy guard: if a recording is still in flight when the next
  // interval fires, the new tick is skipped rather than overlapping with the
  // one still running — mirrors MonitoringWorker's own guard against
  // concurrent ticks.
  private async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      const entry = await this.recorder.recordAutonomousPlanCycle();
      console.log(`autonomous-plan-recording-worker: recorded cycle ${entry.cycleNumber}`);
      this.lastSuccessfulCycleAt = new Date();
      this.lastRecordedCycleNumber = entry.cycleNumber;
      this.lastError = undefined;
    } catch (error) {
      // Caught and logged, never rethrown — a failed recording must never
      // stop this worker's timer or propagate out of the interval callback,
      // same as MonitoringWorker's own tick() failure handling. Unchanged by
      // Phase 10.3 except for also recording the message below.
      const message = error instanceof Error ? error.message : String(error);
      console.error("autonomous-plan-recording-worker: tick failed:", message);
      this.lastError = message;
    } finally {
      this.ticking = false;
    }
  }

  // Concrete, additive method — deliberately not part of IBackgroundWorker
  // (whose contract stays generic across any future worker type), same
  // reasoning MonitoringWorker.getStatus() already established. Read-only:
  // reports state already tracked for tick()'s own bookkeeping above, never
  // triggers a tick or any other side effect.
  getStatus(): { running: boolean; lastSuccessfulCycleAt?: Date; lastRecordedCycleNumber?: number; lastError?: string } {
    return {
      running: this.intervalHandle !== undefined,
      lastSuccessfulCycleAt: this.lastSuccessfulCycleAt,
      lastRecordedCycleNumber: this.lastRecordedCycleNumber,
      lastError: this.lastError,
    };
  }
}
