import type { IAutonomousPlanScheduleProvider } from "../application/interfaces";
import type { IAutonomousExecutionOrchestrator } from "../autonomousexecution/interfaces";
import type { IRecentExecutionHistoryProvider } from "../memory/interfaces";
import type { IBackgroundWorker } from "./interfaces";

// Kept as an internal constant for now, matching every other worker's own
// "kept internal for now" interval precedent. Same order of magnitude as
// AutonomousPlanRecordingWorker's own default -- attempting execution more
// often than the schedule itself can change (which only happens once a new
// planning cycle is recorded) gains nothing.
const DEFAULT_EXECUTION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// How recent a repository's last execution event must be before this worker
// treats it as "already attempted, skip this tick". Deliberately a plain
// time window over IRecentExecutionHistoryProvider's own already-recorded
// data, not a new accumulating store of its own -- see
// AutonomousExecutionWorker's own doc comment for why this is a circuit
// breaker against repeated failure, not an attempt at precise recommendation
// identity matching.
const RECENT_EXECUTION_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Phase 13: the first thing to call AutonomousExecutionOrchestrator without
// a human directly in the loop. Owns its own execution cadence (a plain
// interval timer), same as MonitoringWorker/AutonomousPlanRecordingWorker —
// BackgroundRuntime only starts/stops this worker, it has no opinion on how
// often it ticks.
//
// Depends on IAutonomousPlanScheduleProvider (to see which repository would
// be attempted, before attempting it), IRecentExecutionHistoryProvider (to
// decide whether to skip), and IAutonomousExecutionOrchestrator (to actually
// attempt) — nothing else. Never depends on IExecutionPipeline, IControllerCore,
// or IApprovalEngine directly, and never supplies a correlationId to
// attemptExecution(): there is no chat this worker's own trigger could ever
// correlate back to, so any approval-gated step downstream is denied by
// TelegramApprovalProvider's own existing, unmodified logic — the same
// fail-closed behavior Phase 11 always had for a non-Telegram caller,
// preserved deliberately, not worked around.
//
// The dedup check here is intentionally coarse: "was there any recorded
// execution for this repository within the last window" is a proxy for
// "was this specific recommendation already attempted", not an exact match
// -- ProjectMemoryEvent has no concept of RecommendationKind to match on
// precisely (see the Phase 13 deduplication review). A repository that
// actually shipped successfully already stops appearing as
// RepositoryReadyToShip on its own, once the next planning cycle is
// recorded, via the existing Evolution/Readiness/Sequencing/Scheduling
// logic — this worker's own history check only needs to catch the
// remaining case: not retrying a recently failed or denied attempt on
// every single tick.
export class AutonomousExecutionWorker implements IBackgroundWorker {
  readonly id = "autonomous-execution-worker";

  private intervalHandle?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly scheduleProvider: IAutonomousPlanScheduleProvider,
    private readonly historyProvider: IRecentExecutionHistoryProvider,
    private readonly orchestrator: IAutonomousExecutionOrchestrator,
    private readonly intervalMs: number = DEFAULT_EXECUTION_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.intervalHandle) {
      return;
    }
    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // unref()'d deliberately, same as every other worker's own timer: this
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

  // Re-entrancy guard: if a tick is still in flight when the next interval
  // fires, the new tick is skipped rather than overlapping with the one
  // still running — mirrors every other worker's own guard against
  // concurrent ticks.
  private async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      const schedule = await this.scheduleProvider.getAutonomousPlanSchedule(1);
      const [topEntry] = schedule.entries;
      if (!topEntry) {
        return;
      }

      const recentEvents = await this.historyProvider.getRecentEvents({ repositoryId: topEntry.repositoryId, limit: 1 });
      const [mostRecentEvent] = recentEvents;
      if (mostRecentEvent && Date.now() - mostRecentEvent.recordedAt.getTime() < RECENT_EXECUTION_WINDOW_MS) {
        console.log(`autonomous-execution-worker: skipping ${topEntry.repositoryId} -- an execution was recorded for it within the last ${RECENT_EXECUTION_WINDOW_MS / 60_000} minute(s)`);
        return;
      }

      // No correlationId supplied, deliberately — see this class's own doc
      // comment. Never attempts to translate a RecommendationKind itself;
      // that decision belongs entirely to the orchestrator, unchanged.
      const result = await this.orchestrator.attemptExecution();
      console.log(
        result
          ? `autonomous-execution-worker: attempted execution for ${topEntry.repositoryId} (${topEntry.sourceRecommendationKind})`
          : `autonomous-execution-worker: nothing eligible for execution this cycle`,
      );
    } catch (error) {
      // Caught and logged, never rethrown — a failed attempt must never stop
      // this worker's timer or propagate out of the interval callback, same
      // as every other worker's own tick() failure handling.
      console.error("autonomous-execution-worker: tick failed:", error instanceof Error ? error.message : error);
    } finally {
      this.ticking = false;
    }
  }
}
