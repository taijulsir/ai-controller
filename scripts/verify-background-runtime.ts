import { spawn } from "node:child_process";
import path from "node:path";
import type { IAttentionDispatcher } from "../src/attention/interfaces";
import type { AttentionDispatcherStatus } from "../src/attention/types";
import type { IProactiveMonitor } from "../src/monitoring/interfaces";
import type { AttentionEvent } from "../src/monitoring/types";
import type { Repository } from "../src/domain/repository/Repository";
import type { IRuntimePolicyEngine } from "../src/policy/interfaces";
import type { RuntimePolicyDecision, RuntimePolicyStatus } from "../src/policy/types";
import type { IRepositoryRegistry } from "../src/repositories/interfaces";
import { BackgroundRuntime } from "../src/runtime/BackgroundRuntime";
import { RuntimeAlreadyStartedError } from "../src/runtime/errors";
import type { IBackgroundWorker } from "../src/runtime/interfaces";
import { MonitoringWorker } from "../src/runtime/MonitoringWorker";

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RecordingWorker implements IBackgroundWorker {
  startCalls = 0;
  stopCalls = 0;

  constructor(
    public readonly id: string,
    private readonly callLog: string[],
    private readonly failOnStart = false,
    private readonly failOnStop = false,
  ) {}

  start(): void {
    this.startCalls += 1;
    this.callLog.push(`start:${this.id}`);
    if (this.failOnStart) {
      throw new Error(`${this.id} refuses to start`);
    }
  }

  stop(): void {
    this.stopCalls += 1;
    this.callLog.push(`stop:${this.id}`);
    if (this.failOnStop) {
      throw new Error(`${this.id} refuses to stop`);
    }
  }
}

function repository(id: string): Repository {
  return { id, name: id, path: `/repos/${id}`, defaultBranch: "main", active: false };
}

class FakeRepositoryRegistry implements IRepositoryRegistry {
  constructor(private readonly repositories: Repository[]) {}
  getAllRepositories(): Repository[] {
    return this.repositories;
  }
  getRepository(id: string): Repository {
    const found = this.repositories.find((repo) => repo.id === id);
    if (!found) throw new Error(`not used: ${id}`);
    return found;
  }
  getActiveRepository(): Repository | undefined {
    return this.repositories.find((repo) => repo.active);
  }
  setActiveRepository(): void {
    throw new Error("not used");
  }
  repositoryExists(id: string): boolean {
    return this.repositories.some((repo) => repo.id === id);
  }
  refresh(): void {
    throw new Error("not used");
  }
}

class FakeProactiveMonitor implements IProactiveMonitor {
  evaluateCalls: string[] = [];
  private inFlight = 0;
  maxConcurrentObserved = 0;

  constructor(
    private readonly eventsFor: (repositoryId: string) => AttentionEvent[],
    private readonly delayMs = 0,
  ) {}

  async evaluate(repositoryId?: string): Promise<AttentionEvent[]> {
    const id = repositoryId ?? "unknown";
    this.evaluateCalls.push(id);
    this.inFlight += 1;
    this.maxConcurrentObserved = Math.max(this.maxConcurrentObserved, this.inFlight);
    if (this.delayMs > 0) {
      await delay(this.delayMs);
    }
    this.inFlight -= 1;
    return this.eventsFor(id);
  }
}

function attentionEvent(repositoryId: string): AttentionEvent {
  return {
    repositoryId,
    trigger: "new-urgent-recommendation",
    recommendationKind: "PullRequired",
    category: "blocking",
    priority: "high",
    reason: "test event",
    generatedAt: new Date(),
  };
}

class FakeAttentionDispatcher implements IAttentionDispatcher {
  dispatchCalls: AttentionEvent[][] = [];

  constructor(
    private readonly delayMs = 0,
    private readonly shouldThrow = false,
  ) {}

  async dispatch(events: AttentionEvent[]): Promise<void> {
    if (this.delayMs > 0) {
      await delay(this.delayMs);
    }
    this.dispatchCalls.push(events);
    if (this.shouldThrow) {
      throw new Error("dispatcher refuses to dispatch");
    }
  }

  getStatus(): AttentionDispatcherStatus {
    return { lastDispatchAt: undefined, notificationsDelivered: 0, notificationsSuppressed: 0 };
  }
  resetStatistics(): void {}
}

// Allows everything by default — only the "policy gating" tests below
// override monitoringDecisionFor to deny a specific repository.
class FakeRuntimePolicyEngine implements IRuntimePolicyEngine {
  monitoringDecisionFor: (repositoryId: string) => RuntimePolicyDecision = () => ({ allowed: true });

  evaluateMonitoring(repositoryId: string): RuntimePolicyDecision {
    return this.monitoringDecisionFor(repositoryId);
  }
  evaluateNotification(): RuntimePolicyDecision {
    return { allowed: true };
  }
  recordNotificationSent(): void {}
  setMaintenanceMode(): void {}
  setRepositoryMonitoringEnabled(): void {}
  getStatus(): RuntimePolicyStatus {
    return {
      maintenanceMode: false,
      quietHoursActive: false,
      repositoriesDisabled: 0,
      repositoriesInCooldown: 0,
      globalNotificationBudget: { used: 0, max: 0, windowMs: 0 },
    };
  }
}

async function main(): Promise<void> {
  // BackgroundRuntime starts and stops a fixed set of workers, in construction
  // order for start() and reverse order for stop().
  {
    const callLog: string[] = [];
    const w1 = new RecordingWorker("w1", callLog);
    const w2 = new RecordingWorker("w2", callLog);
    const runtime = new BackgroundRuntime([w1, w2]);

    runtime.start();
    assert(w1.startCalls === 1 && w2.startCalls === 1, "start() starts every worker exactly once");
    assert(
      callLog.slice(0, 2).join(",") === "start:w1,start:w2",
      "workers are started in construction order",
    );

    runtime.stop();
    assert(w1.stopCalls === 1 && w2.stopCalls === 1, "stop() stops every worker exactly once");
    assert(
      callLog.slice(2, 4).join(",") === "stop:w2,stop:w1",
      "workers are stopped in reverse of construction order",
    );
  }

  // Double-start is rejected; BackgroundRuntime has no scheduling policy of
  // its own to get confused by this, it is purely a start/stop guard.
  {
    const runtime = new BackgroundRuntime([new RecordingWorker("solo", [])]);
    runtime.start();
    let threw = false;
    try {
      runtime.start();
    } catch (error) {
      threw = error instanceof RuntimeAlreadyStartedError;
    }
    assert(threw, "calling start() twice throws RuntimeAlreadyStartedError");
    runtime.stop();
  }

  // stop() is safe even if start() was never called.
  {
    const worker = new RecordingWorker("never-started", []);
    const runtime = new BackgroundRuntime([worker]);
    let threw = false;
    try {
      runtime.stop();
    } catch {
      threw = true;
    }
    assert(!threw, "stop() before start() does not throw");
    assert(worker.stopCalls === 1, "stop() still asks every worker to stop, even if never started");
  }

  // A worker that throws on start()/stop() does not prevent its siblings from
  // starting/stopping — workers are isolated from each other.
  {
    const callLog: string[] = [];
    const failing = new RecordingWorker("failing", callLog, true, true);
    const healthy = new RecordingWorker("healthy", callLog);
    const runtime = new BackgroundRuntime([failing, healthy]);

    let threw = false;
    try {
      runtime.start();
    } catch {
      threw = true;
    }
    assert(!threw, "BackgroundRuntime.start() does not propagate a single worker's start() failure");
    assert(healthy.startCalls === 1, "a sibling worker still starts after another worker's start() throws");

    threw = false;
    try {
      runtime.stop();
    } catch {
      threw = true;
    }
    assert(!threw, "BackgroundRuntime.stop() does not propagate a single worker's stop() failure");
    assert(healthy.stopCalls === 1, "a sibling worker still stops after another worker's stop() throws");
  }

  // MonitoringWorker ticks on its own internal interval (no shared IScheduler),
  // calls IProactiveMonitor.evaluate() once per registered repository per
  // tick, and stops ticking once stop() is called.
  {
    const monitor = new FakeProactiveMonitor(() => []);
    const registry = new FakeRepositoryRegistry([repository("alpha"), repository("beta")]);
    const dispatcher = new FakeAttentionDispatcher();
    const policy = new FakeRuntimePolicyEngine();
    const worker = new MonitoringWorker(monitor, registry, dispatcher, policy, 20);

    worker.start();
    await delay(55); // ~2 ticks at 20ms, generous margin
    worker.stop();
    const callsAtStop = monitor.evaluateCalls.length;

    assert(callsAtStop >= 4, `worker ticks its own interval and evaluates every registered repository per tick (saw ${callsAtStop} calls across >=2 ticks x 2 repos)`);
    assert(
      monitor.evaluateCalls.slice(0, 2).sort().join(",") === "alpha,beta",
      "each tick evaluates every registered repository, not just one",
    );

    await delay(60);
    assert(monitor.evaluateCalls.length === callsAtStop, "no further ticks occur after stop()");
  }

  // Re-entrancy guard: a slow evaluate() must not let two ticks run concurrently.
  {
    const monitor = new FakeProactiveMonitor(() => [], 40);
    const registry = new FakeRepositoryRegistry([repository("alpha")]);
    const dispatcher = new FakeAttentionDispatcher();
    const policy = new FakeRuntimePolicyEngine();
    const worker = new MonitoringWorker(monitor, registry, dispatcher, policy, 10);

    worker.start();
    await delay(90);
    worker.stop();

    assert(monitor.maxConcurrentObserved === 1, "overlapping ticks are skipped — evaluate() is never called concurrently with itself");
  }

  // start()/stop() are idempotent — no leaked timers from calling either twice.
  {
    const monitor = new FakeProactiveMonitor(() => []);
    const registry = new FakeRepositoryRegistry([repository("alpha")]);
    const dispatcher = new FakeAttentionDispatcher();
    const policy = new FakeRuntimePolicyEngine();
    const worker = new MonitoringWorker(monitor, registry, dispatcher, policy, 15);

    worker.start();
    worker.start(); // should be a no-op, not a second interval
    worker.stop();
    worker.stop(); // should be a no-op, not an error
    const callsAfterDoubleStop = monitor.evaluateCalls.length;

    await delay(50);
    assert(
      monitor.evaluateCalls.length === callsAfterDoubleStop,
      "calling start() or stop() twice does not leak a second interval",
    );
  }

  // Phase 8.3: MonitoringWorker forwards each tick's events to
  // IAttentionDispatcher.dispatch() — still just an abstraction call, no
  // Telegram/transport knowledge anywhere in this class.
  {
    const monitor = new FakeProactiveMonitor((id) => [attentionEvent(id)]);
    const registry = new FakeRepositoryRegistry([repository("alpha")]);
    const dispatcher = new FakeAttentionDispatcher();
    const policy = new FakeRuntimePolicyEngine();
    const worker = new MonitoringWorker(monitor, registry, dispatcher, policy, 20);

    worker.start();
    await delay(25);
    worker.stop();

    assert(dispatcher.dispatchCalls.length >= 1, "MonitoringWorker forwards each tick's events to IAttentionDispatcher.dispatch()");
    assert(
      dispatcher.dispatchCalls[0]?.[0]?.repositoryId === "alpha",
      "dispatch() receives the exact events evaluate() produced for that repository",
    );
  }

  // Phase 8.3: dispatch() is awaited before the worker moves on, not fired
  // and forgotten — a slow dispatcher delays the next repository's evaluate()
  // within the same tick, exactly like a slow evaluate() already did before
  // this phase. intervalMs=15 so the first tick starts quickly; evaluate()
  // itself is instant (FakeProactiveMonitor's own delay defaults to 0), only
  // dispatch() is slow (40ms), so the tick's timeline is: ~t15 tick starts,
  // evaluate(alpha) instant, dispatch(alpha) resolves ~t55, evaluate(beta)
  // instant, dispatch(beta) resolves ~t95.
  {
    const monitor = new FakeProactiveMonitor(() => [attentionEvent("alpha")]);
    const registry = new FakeRepositoryRegistry([repository("alpha"), repository("beta")]);
    const dispatcher = new FakeAttentionDispatcher(40);
    const policy = new FakeRuntimePolicyEngine();
    const worker = new MonitoringWorker(monitor, registry, dispatcher, policy, 15);

    worker.start();
    await delay(35); // past tick start (~15ms), well before alpha's dispatch resolves (~55ms)
    const evaluateCallsMidDispatch = monitor.evaluateCalls.length;
    await delay(110); // now past both repositories' dispatch (~95ms), generous margin
    worker.stop();

    assert(
      evaluateCallsMidDispatch === 1,
      "evaluate() for the second repository does not run until the first repository's dispatch() has resolved — dispatch is awaited, not fire-and-forget",
    );
    assert(monitor.evaluateCalls.length >= 2, "the tick resumes and reaches the second repository once dispatch() resolves");
  }

  // Phase 8.3: a throwing dispatcher is handled by the same outer try/catch
  // that already handled evaluate() failures — it does not crash the worker,
  // and the worker keeps ticking normally afterward.
  {
    const monitor = new FakeProactiveMonitor(() => [attentionEvent("alpha")]);
    const registry = new FakeRepositoryRegistry([repository("alpha")]);
    const dispatcher = new FakeAttentionDispatcher(0, true);
    const policy = new FakeRuntimePolicyEngine();
    const worker = new MonitoringWorker(monitor, registry, dispatcher, policy, 20);

    worker.start();
    await delay(55);
    worker.stop();

    assert(monitor.evaluateCalls.length >= 2, "a throwing dispatcher does not stop future ticks from occurring");
  }

  // Phase 8.4: MonitoringWorker asks RuntimePolicy.evaluateMonitoring() per
  // repository, per tick, and skips evaluate()/dispatch() entirely for a
  // repository policy denies — without ever inventing its own reason (the
  // log line consumes decision.reason directly, asserted here only via its
  // observable effect: evaluate() is never called for the denied repo).
  {
    const monitor = new FakeProactiveMonitor(() => []);
    const registry = new FakeRepositoryRegistry([repository("alpha"), repository("beta")]);
    const dispatcher = new FakeAttentionDispatcher();
    const policy = new FakeRuntimePolicyEngine();
    policy.monitoringDecisionFor = (repositoryId) =>
      repositoryId === "alpha" ? { allowed: false, reason: "repository-disabled" } : { allowed: true };
    const worker = new MonitoringWorker(monitor, registry, dispatcher, policy, 20);

    worker.start();
    await delay(25);
    worker.stop();

    assert(!monitor.evaluateCalls.includes("alpha"), "a repository RuntimePolicy denies is never passed to ProactiveMonitor.evaluate()");
    assert(monitor.evaluateCalls.includes("beta"), "a sibling repository RuntimePolicy allows is still evaluated in the same tick");
  }

  // Phase 8.4: when RuntimePolicy denies every repository (e.g. maintenance
  // mode), no repository is evaluated at all this tick — MonitoringWorker
  // does not special-case a global denial, it is just the same per-repository
  // check applied uniformly.
  {
    const monitor = new FakeProactiveMonitor(() => []);
    const registry = new FakeRepositoryRegistry([repository("alpha"), repository("beta")]);
    const dispatcher = new FakeAttentionDispatcher();
    const policy = new FakeRuntimePolicyEngine();
    policy.monitoringDecisionFor = () => ({ allowed: false, reason: "maintenance-mode" });
    const worker = new MonitoringWorker(monitor, registry, dispatcher, policy, 20);

    worker.start();
    await delay(25);
    worker.stop();

    assert(monitor.evaluateCalls.length === 0, "when RuntimePolicy denies every repository, no evaluate() call happens at all");
  }

  // BackgroundRuntime composes a real MonitoringWorker exactly as
  // src/index.ts's Phase 8.2/8.3 wiring does — proving the classes integrate
  // correctly in isolation from the rest of bootstrap.
  {
    const monitor = new FakeProactiveMonitor(() => []);
    const registry = new FakeRepositoryRegistry([repository("alpha")]);
    const dispatcher = new FakeAttentionDispatcher();
    const policy = new FakeRuntimePolicyEngine();
    const worker = new MonitoringWorker(monitor, registry, dispatcher, policy, 20);
    const runtime = new BackgroundRuntime([worker]);

    runtime.start();
    await delay(25);
    runtime.stop();
    assert(monitor.evaluateCalls.length >= 1, "BackgroundRuntime successfully hosts a real MonitoringWorker end-to-end");
  }

  // Phase 8.5: MonitoringWorker.getStatus() reflects real tick activity —
  // running flag, lastCycleAt, and per-repository monitored/skipped counts —
  // not a placeholder or independently-tracked duplicate of the tick logic
  // above.
  {
    const monitor = new FakeProactiveMonitor(() => []);
    const registry = new FakeRepositoryRegistry([repository("alpha"), repository("beta")]);
    const dispatcher = new FakeAttentionDispatcher();
    const policy = new FakeRuntimePolicyEngine();
    policy.monitoringDecisionFor = (repositoryId) => (repositoryId === "alpha" ? { allowed: false, reason: "repository-disabled" } : { allowed: true });
    const worker = new MonitoringWorker(monitor, registry, dispatcher, policy, 20);

    const beforeStart = worker.getStatus();
    assert(!beforeStart.running && beforeStart.lastCycleAt === undefined, "getStatus() before start() reports not running and no prior cycle");

    worker.start();
    assert(worker.getStatus().running === true, "getStatus() reports running: true once start() has been called");

    await delay(25);
    worker.stop();

    const status = worker.getStatus();
    assert(status.running === false, "getStatus() reports running: false once stop() has been called");
    assert(status.lastCycleAt instanceof Date, "getStatus() reports a lastCycleAt timestamp once at least one tick has run");
    assert(
      status.repositoriesMonitoredLastCycle === 1 && status.repositoriesSkippedLastCycle === 1,
      `getStatus() reports the exact monitored/skipped counts from the last tick (saw monitored=${status.repositoriesMonitoredLastCycle}, skipped=${status.repositoriesSkippedLastCycle})`,
    );
  }

  // Phase 8.5: BackgroundRuntime.getStatus() reflects real start/stop
  // activity — running, startedAt/uptimeMs, and per-worker running flags —
  // derived from its own existing start()/stop() bookkeeping, not a new
  // parallel tracking mechanism.
  {
    const callLog: string[] = [];
    const w1 = new RecordingWorker("w1", callLog);
    const w2 = new RecordingWorker("w2", callLog, true); // fails to start
    const runtime = new BackgroundRuntime([w1, w2]);

    const beforeStart = runtime.getStatus();
    assert(!beforeStart.running && beforeStart.startedAt === undefined, "getStatus() before start() reports not running, no startedAt");

    runtime.start();
    const runningStatus = runtime.getStatus();
    assert(runningStatus.running === true && runningStatus.startedAt instanceof Date, "getStatus() reports running: true and a startedAt once start() has run");
    assert(typeof runningStatus.uptimeMs === "number" && runningStatus.uptimeMs >= 0, "getStatus() reports a non-negative uptimeMs while running");
    assert(
      runningStatus.workers.find((w) => w.id === "w1")?.running === true,
      "a worker whose start() succeeded is reported as running: true",
    );
    assert(
      runningStatus.workers.find((w) => w.id === "w2")?.running === false,
      "a worker whose start() threw is reported as running: false, not silently omitted",
    );

    runtime.stop();
    const stoppedStatus = runtime.getStatus();
    assert(stoppedStatus.running === false && stoppedStatus.uptimeMs === undefined, "getStatus() reports running: false and no uptimeMs once stopped");
  }

  // Phase 8.6: BackgroundRuntime.resetStatistics() only resets runtime
  // statistics — since running/startedAt/per-worker running flags are all
  // live lifecycle state (not statistics), getStatus() must be byte-for-byte
  // identical before and after calling it, whether the runtime is running or
  // stopped.
  {
    const w1 = new RecordingWorker("w1", []);
    const runtime = new BackgroundRuntime([w1]);

    runtime.start();
    const beforeReset = runtime.getStatus();
    runtime.resetStatistics();
    const afterReset = runtime.getStatus();
    assert(
      afterReset.running === beforeReset.running &&
        afterReset.startedAt?.getTime() === beforeReset.startedAt?.getTime() &&
        JSON.stringify(afterReset.workers) === JSON.stringify(beforeReset.workers),
      "resetStatistics() while running leaves running/startedAt/workers completely unchanged",
    );

    runtime.stop();
    const stoppedBeforeReset = runtime.getStatus();
    runtime.resetStatistics();
    const stoppedAfterReset = runtime.getStatus();
    assert(
      JSON.stringify(stoppedAfterReset) === JSON.stringify(stoppedBeforeReset),
      "resetStatistics() while stopped leaves getStatus()'s output completely unchanged",
    );
  }

  // The core Phase 8.2 guarantee: BackgroundRuntime keeps a process alive on
  // its own, independent of any worker's own ref()/unref() choice and
  // independent of Telegram. Spawned as a real child process (not just an
  // in-process assertion) because "does this keep Node alive" is a process-
  // level fact, not something an in-process check can honestly observe.
  {
    const childPath = path.resolve(__dirname, "_verify-background-runtime-keepalive-child.ts");
    const child = spawn("npx", ["tsx", childPath], { stdio: "ignore" });

    await delay(500);
    const stillAlive = child.exitCode === null && child.signalCode === null;
    assert(stillAlive, "BackgroundRuntime.start() keeps a bare process alive on its own, with zero workers and no Telegram involved");

    child.kill("SIGKILL");
  }
}

main();
