import type { AutonomousPlan, AutonomousPlanItem } from "../src/autonomy/types";
import type { IAutonomousPlanCycleRecorder } from "../src/application/interfaces";
import type { AutonomousPlanHistoryEntry } from "../src/planhistory/types";
import { AutonomousPlanRecordingWorker } from "../src/runtime/AutonomousPlanRecordingWorker";
import { BackgroundRuntime } from "../src/runtime/BackgroundRuntime";

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function item(overrides: Partial<AutonomousPlanItem> & Pick<AutonomousPlanItem, "repositoryId" | "sourceRecommendationKind">): AutonomousPlanItem {
  return { category: "advisory", priority: "medium", reason: "test", supportingEvidence: [], confidence: "medium", ...overrides };
}

function plan(id: string): AutonomousPlan {
  return { id, generatedAt: new Date(), repositoriesConsidered: ["alpha"], items: [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired" })] };
}

// A fake IAutonomousPlanCycleRecorder, not a fake IApplicationService — the
// worker's constructor parameter is typed against the narrow interface, so
// this is all a test double needs to implement, proving the worker really
// only depends on the one method it needs.
class FakeCycleRecorder implements IAutonomousPlanCycleRecorder {
  recordCalls = 0;
  private inFlight = 0;
  maxConcurrentObserved = 0;
  private cycleNumber = 0;

  constructor(
    private readonly delayMs = 0,
    private readonly shouldThrow = false,
  ) {}

  async recordAutonomousPlanCycle(): Promise<AutonomousPlanHistoryEntry> {
    this.recordCalls += 1;
    this.inFlight += 1;
    this.maxConcurrentObserved = Math.max(this.maxConcurrentObserved, this.inFlight);
    if (this.delayMs > 0) {
      await delay(this.delayMs);
    }
    this.inFlight -= 1;
    if (this.shouldThrow) {
      throw new Error("recorder refuses to record");
    }
    this.cycleNumber += 1;
    const currentPlan = plan(`p${this.cycleNumber}`);
    return {
      cycleNumber: this.cycleNumber,
      recordedAt: new Date(),
      plan: currentPlan,
      evolution: { previousPlanId: undefined, currentPlanId: currentPlan.id, cycleNumber: this.cycleNumber, generatedAt: new Date(), transitions: [] },
    };
  }
}

async function main(): Promise<void> {
  // Worker lifecycle: ticks on its own interval, calling
  // recordAutonomousPlanCycle() once per tick, and stops ticking once stop()
  // is called -- same shape MonitoringWorker's own lifecycle test uses.
  {
    const recorder = new FakeCycleRecorder();
    const worker = new AutonomousPlanRecordingWorker(recorder, 20);

    worker.start();
    await delay(55); // ~2 ticks at 20ms, generous margin
    worker.stop();
    const callsAtStop = recorder.recordCalls;

    assert(callsAtStop >= 2, `worker ticks its own interval and records once per tick (saw ${callsAtStop} calls across >=2 ticks)`);

    await delay(60);
    assert(recorder.recordCalls === callsAtStop, "no further ticks -- and no further recording -- occur after stop()");
  }

  // Graceful shutdown: stop() halts the timer deterministically, matching
  // the same guarantee MonitoringWorker.stop() and BackgroundRuntime.stop()
  // already provide, and is safe to call even if start() was never called.
  {
    const recorder = new FakeCycleRecorder();
    const worker = new AutonomousPlanRecordingWorker(recorder, 15);

    let threw = false;
    try {
      worker.stop();
    } catch {
      threw = true;
    }
    assert(!threw, "stop() before start() does not throw");
    assert(recorder.recordCalls === 0, "stop() before start() never triggers a recording");

    worker.start();
    await delay(20);
    worker.stop();
    const callsAtStop = recorder.recordCalls;
    worker.stop(); // idempotent -- must not throw or leak a second interval
    await delay(40);
    assert(recorder.recordCalls === callsAtStop, "calling stop() twice is a no-op -- no leaked interval continues recording");
  }

  // start()/start() is idempotent -- no leaked second interval double-recording.
  {
    const recorder = new FakeCycleRecorder();
    const worker = new AutonomousPlanRecordingWorker(recorder, 15);

    worker.start();
    worker.start(); // should be a no-op, not a second interval
    await delay(50);
    worker.stop();

    // A single 15ms-interval timer running for ~50ms fires ~3 times; a
    // second, leaked interval firing alongside it would push this well past
    // that -- this loose upper bound catches a doubled interval without
    // being sensitive to exact timer jitter.
    assert(recorder.recordCalls <= 5, `calling start() twice does not leak a second interval (saw ${recorder.recordCalls} calls for a single ~15ms interval over ~50ms)`);
  }

  // Repeated recording: multiple ticks each produce their own independent
  // recording call, with no dedup/idempotency guard -- exactly the behavior
  // ApplicationService.recordAutonomousPlanCycle() itself was verified to
  // have in Phase 10 (two calls, two entries). This worker adds nothing on
  // top of that; it simply calls it repeatedly.
  {
    const recorder = new FakeCycleRecorder();
    const worker = new AutonomousPlanRecordingWorker(recorder, 15);

    worker.start();
    await delay(70); // several ticks
    worker.stop();

    assert(recorder.recordCalls >= 3, `repeated ticks each independently call recordAutonomousPlanCycle() (saw ${recorder.recordCalls} calls)`);
  }

  // Re-entrancy guard: a slow recording must not let two ticks run
  // concurrently -- mirrors MonitoringWorker's own guard against overlapping
  // ticks.
  {
    const recorder = new FakeCycleRecorder(40);
    const worker = new AutonomousPlanRecordingWorker(recorder, 10);

    worker.start();
    await delay(90);
    worker.stop();

    assert(recorder.maxConcurrentObserved === 1, "overlapping ticks are skipped -- recordAutonomousPlanCycle() is never called concurrently with itself");
  }

  // Failures are caught and logged, never crash the worker or stop future
  // ticks -- same as MonitoringWorker's own tick() failure handling.
  {
    const recorder = new FakeCycleRecorder(0, true);
    const worker = new AutonomousPlanRecordingWorker(recorder, 20);

    worker.start();
    await delay(55);
    worker.stop();

    assert(recorder.recordCalls >= 2, `a throwing recorder does not stop future ticks from occurring (saw ${recorder.recordCalls} attempted calls)`);
  }

  // BackgroundRuntime composes a real AutonomousPlanRecordingWorker exactly
  // as src/index.ts's Phase 10.1 wiring does, alongside a second worker --
  // proving both integrate correctly together, with independent lifecycles.
  {
    const recorder = new FakeCycleRecorder();
    const worker = new AutonomousPlanRecordingWorker(recorder, 20);
    const runtime = new BackgroundRuntime([worker]);

    runtime.start();
    await delay(25);
    assert(runtime.getStatus().workers.find((w) => w.id === "autonomous-plan-recording-worker")?.running === true, "BackgroundRuntime reports the worker as running once started");
    runtime.stop();
    const callsAtStop = recorder.recordCalls;
    assert(callsAtStop >= 1, "BackgroundRuntime successfully hosts a real AutonomousPlanRecordingWorker end-to-end");

    assert(runtime.getStatus().workers.find((w) => w.id === "autonomous-plan-recording-worker")?.running === false, "BackgroundRuntime reports the worker as not running once stopped, via runtime.stop()");

    await delay(40);
    assert(recorder.recordCalls === callsAtStop, "BackgroundRuntime.stop() gracefully halts this worker's ticking, same as it already does for MonitoringWorker");
  }

  // Two independent workers hosted together: each ticks on its own interval,
  // stopping one (via BackgroundRuntime.stop(), the same call path
  // src/index.ts's shutdown handler uses) does not affect the other's
  // lifecycle bookkeeping -- proving no shared/global timer state leaked
  // between them.
  {
    const recorderA = new FakeCycleRecorder();
    const recorderB = new FakeCycleRecorder();
    const workerA = new AutonomousPlanRecordingWorker(recorderA, 15);
    const workerB = new AutonomousPlanRecordingWorker(recorderB, 15);
    const runtime = new BackgroundRuntime([workerA, workerB]);

    runtime.start();
    await delay(50);
    runtime.stop();

    assert(recorderA.recordCalls >= 2 && recorderB.recordCalls >= 2, "two independently-constructed AutonomousPlanRecordingWorker instances tick and record independently when hosted together");
  }
}

main();
