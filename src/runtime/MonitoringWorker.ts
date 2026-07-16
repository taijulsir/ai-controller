import type { IAttentionDispatcher } from "../attention/interfaces";
import type { IProactiveMonitor } from "../monitoring/interfaces";
import type { AttentionEvent } from "../monitoring/types";
import type { IRuntimePolicyEngine } from "../policy/interfaces";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import type { IBackgroundWorker } from "./interfaces";
import type { MonitoringWorkerStatus } from "./types";

// Kept as an internal constant for now, matching DecisionEngine/ProactiveMonitor's
// own "kept internal for now" precedent — promote to controller.yaml if a
// future phase needs it configurable.
const DEFAULT_MONITORING_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// Owns its own execution cadence (a plain interval timer) rather than
// depending on any shared scheduler abstraction — BackgroundRuntime only
// starts/stops this worker, it has no opinion on how often it ticks.
//
// Read-only by construction: its dependencies are IProactiveMonitor (itself
// read-only), IRepositoryRegistry, IAttentionDispatcher (Phase 8.3), and
// IRuntimePolicyEngine (Phase 8.4) — all abstractions this worker depends on
// without knowing which concrete implementation sits behind them. None of
// them carry any transport-specific concept (Telegram or otherwise), and this
// class has no dependency capable of executing a Task/workflow or reaching
// ExecutionPipeline/ControllerCore, because nothing here can reach them at
// all. Its flow per repository, per tick, is exactly three steps and no
// more: ask policy, then (if allowed) evaluate, then dispatch. It consumes
// RuntimePolicyDecision.reason directly for its log line — it never invents
// or re-derives a reason of its own, and performs no policy composition of
// its own beyond checking `decision.allowed` once.
export class MonitoringWorker implements IBackgroundWorker {
  readonly id = "monitoring-worker";

  private intervalHandle?: NodeJS.Timeout;
  private ticking = false;
  // Phase 8.5: additive bookkeeping only, updated inside tick()'s existing
  // finally block — no change to tick()'s control flow or outcome.
  private lastCycleAt?: Date;
  private repositoriesMonitoredLastCycle = 0;
  private repositoriesSkippedLastCycle = 0;

  constructor(
    private readonly proactiveMonitor: IProactiveMonitor,
    private readonly repositoryRegistry: IRepositoryRegistry,
    private readonly attentionDispatcher: IAttentionDispatcher,
    private readonly runtimePolicy: IRuntimePolicyEngine,
    private readonly intervalMs: number = DEFAULT_MONITORING_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.intervalHandle) {
      return;
    }
    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // unref()'d deliberately: this worker is not wired into the composition
    // root yet (Phase 8.1 keeps it dormant), so its timer must never be what
    // keeps the process alive. Whether a live-wired instance should ref() its
    // timer is a decision for the later phase that actually starts it there.
    this.intervalHandle.unref?.();
  }

  stop(): void {
    if (!this.intervalHandle) {
      return;
    }
    clearInterval(this.intervalHandle);
    this.intervalHandle = undefined;
  }

  // Re-entrancy guard: if a tick (evaluating every registered repository) is
  // still in flight when the next interval fires, the new tick is skipped
  // rather than overlapping with the one still running — mirrors
  // TaskPlanner's own running-count guard against concurrent work.
  private async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    let monitoredCount = 0;
    let skippedCount = 0;
    try {
      for (const repository of this.repositoryRegistry.getAllRepositories()) {
        const decision = this.runtimePolicy.evaluateMonitoring(repository.id);
        if (!decision.allowed) {
          skippedCount += 1;
          console.log(`monitoring-worker: monitoring suppressed for ${repository.id} (${decision.reason})`);
          continue;
        }

        monitoredCount += 1;
        const events = await this.proactiveMonitor.evaluate(repository.id);
        this.logEvents(events);
        // Awaited deliberately (Phase 8.3): the monitoring cadence is low
        // enough that deterministic delivery — knowing dispatch finished
        // before moving to the next repository or ending the tick — is
        // preferable to a fire-and-forget call that could still be in
        // flight when the process exits. A dispatch failure is handled
        // entirely inside IAttentionDispatcher (it never rejects), so it
        // cannot itself abort this loop; only a genuine evaluate() failure
        // can, exactly as before Phase 8.3.
        await this.attentionDispatcher.dispatch(events);
      }
    } catch (error) {
      console.error("monitoring-worker: tick failed:", error instanceof Error ? error.message : error);
    } finally {
      this.ticking = false;
      // Phase 8.5: recorded regardless of whether the tick completed fully
      // or aborted partway via the catch above — "last cycle" means the last
      // time a tick ran, not specifically the last time one fully succeeded.
      // The counts reflect only what was actually processed before any
      // abort, which is an honest partial-tick count, not a fabricated total.
      this.lastCycleAt = new Date();
      this.repositoriesMonitoredLastCycle = monitoredCount;
      this.repositoriesSkippedLastCycle = skippedCount;
    }
  }

  private logEvents(events: AttentionEvent[]): void {
    for (const event of events) {
      console.log(`monitoring-worker: attention event — ${event.repositoryId}: ${event.reason}`);
    }
  }

  // Concrete, additive method — deliberately not part of IBackgroundWorker
  // (whose contract stays generic across any future worker type) or any new
  // single-purpose interface invented just to expose this one getter.
  // Read-only: reports state already tracked for tick()'s own bookkeeping,
  // never triggers a tick or any other side effect.
  getStatus(): MonitoringWorkerStatus {
    return {
      running: this.intervalHandle !== undefined,
      lastCycleAt: this.lastCycleAt,
      repositoriesMonitoredLastCycle: this.repositoriesMonitoredLastCycle,
      repositoriesSkippedLastCycle: this.repositoriesSkippedLastCycle,
    };
  }
}
