import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IConfigService } from "../../config/interfaces";
import type { ControllerConfig } from "../../config/types";
import type { ExecutionRequest, ExecutionResult } from "../../controller/types";
import type { Repository } from "../../domain/repository/Repository";
import type { IRepositoryRegistry } from "../../repositories/interfaces";
import { FAILURE_BLOCK_THRESHOLD, ProjectMemoryService } from "../ProjectMemoryService";
import type { ProjectMemoryEvent } from "../types";

const FAILURE_STATE_FILE_NAME = "failure-state.json";

const REPOSITORY_ID = "repo-1";

function fakeRegistry(): IRepositoryRegistry {
  const repository: Repository = { id: REPOSITORY_ID, name: REPOSITORY_ID, path: "/tmp/repo", defaultBranch: "main", active: true };
  return {
    getAllRepositories: () => [repository],
    getRepository: () => repository,
    getActiveRepository: () => repository,
    setActiveRepository: () => {},
    repositoryExists: () => true,
    refresh: () => {},
  };
}

function fakeConfigService(directory: string, enabled = true): IConfigService {
  const controllerConfig = { memory: { enabled, directory } } as ControllerConfig;
  return {
    getControllerConfig: () => controllerConfig,
    getClaudeConfig: () => undefined as never,
    getGithubConfig: () => undefined as never,
    getTelegramConfig: () => undefined as never,
    getRepositories: () => [],
    reload: () => {},
  };
}

function taskRequest(taskType: string): ExecutionRequest {
  return { kind: "task", task: { type: taskType } as never, repositoryId: REPOSITORY_ID };
}

function successResult(taskType: string): ExecutionResult {
  return {
    kind: "task",
    taskResult: { taskType, success: true, correlationId: "corr-1" } as never,
    startedAt: new Date(),
    completedAt: new Date(),
    durationMs: 1,
  };
}

function failureResult(taskType: string): ExecutionResult {
  return {
    kind: "task",
    taskResult: { taskType, success: false, error: "boom", correlationId: "corr-1" } as never,
    startedAt: new Date(),
    completedAt: new Date(),
    durationMs: 1,
  };
}

describe("ProjectMemoryService — failure state", () => {
  let directory: string;
  let service: ProjectMemoryService;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "project-memory-"));
    service = new ProjectMemoryService(fakeRegistry(), fakeConfigService(directory));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("increments consecutiveFailures on repeated failures and resets to 0 on success", async () => {
    await service.record(taskRequest("sync"), { kind: "result", result: failureResult("sync") });
    let state = await service.getFailureState(REPOSITORY_ID, "sync" as never);
    expect(state?.consecutiveFailures).toBe(1);

    await service.record(taskRequest("sync"), { kind: "result", result: failureResult("sync") });
    state = await service.getFailureState(REPOSITORY_ID, "sync" as never);
    expect(state?.consecutiveFailures).toBe(2);

    await service.record(taskRequest("sync"), { kind: "result", result: successResult("sync") });
    state = await service.getFailureState(REPOSITORY_ID, "sync" as never);
    expect(state?.consecutiveFailures).toBe(0);
    expect(state?.blocked).toBe(false);
  });

  it("marks blocked only once consecutiveFailures reaches FAILURE_BLOCK_THRESHOLD (5)", async () => {
    for (let i = 0; i < FAILURE_BLOCK_THRESHOLD - 1; i++) {
      await service.record(taskRequest("push-changes"), { kind: "result", result: failureResult("push-changes") });
    }
    let state = await service.getFailureState(REPOSITORY_ID, "push-changes" as never);
    expect(state?.consecutiveFailures).toBe(FAILURE_BLOCK_THRESHOLD - 1);
    expect(state?.blocked).toBe(false);

    await service.record(taskRequest("push-changes"), { kind: "result", result: failureResult("push-changes") });
    state = await service.getFailureState(REPOSITORY_ID, "push-changes" as never);
    expect(state?.consecutiveFailures).toBe(FAILURE_BLOCK_THRESHOLD);
    expect(state?.blocked).toBe(true);
  });

  it("tracks failures for different task types independently", async () => {
    await service.record(taskRequest("sync"), { kind: "result", result: failureResult("sync") });
    await service.record(taskRequest("sync"), { kind: "result", result: failureResult("sync") });
    const syncState = await service.getFailureState(REPOSITORY_ID, "sync" as never);
    const implementState = await service.getFailureState(REPOSITORY_ID, "implement-feature" as never);
    expect(syncState?.consecutiveFailures).toBe(2);
    expect(implementState).toBeUndefined();
  });

  it("counts a thrown error as a failure (deliberate behavior change)", async () => {
    await service.record(taskRequest("fix-bug"), { kind: "error", error: "exploded" });
    const state = await service.getFailureState(REPOSITORY_ID, "fix-bug" as never);
    expect(state?.consecutiveFailures).toBe(1);
    expect(state?.lastFailure).toBeInstanceOf(Date);
  });

  it("clearFailureState resets one task type's counter and appends an audit event without touching prior events", async () => {
    await service.record(taskRequest("sync"), { kind: "result", result: failureResult("sync") });
    await service.record(taskRequest("push-changes"), { kind: "result", result: failureResult("push-changes") });

    await service.clearFailureState(REPOSITORY_ID, "sync" as never);

    const syncState = await service.getFailureState(REPOSITORY_ID, "sync" as never);
    const pushState = await service.getFailureState(REPOSITORY_ID, "push-changes" as never);
    expect(syncState).toBeUndefined();
    expect(pushState?.consecutiveFailures).toBe(1);

    const events: ProjectMemoryEvent[] = await service.getRecentEvents({ repositoryId: REPOSITORY_ID, limit: 10 });
    expect(events.some((event) => event.outcome.kind === "failure-state-cleared" && event.outcome.taskType === "sync")).toBe(true);
    expect(events.filter((event) => event.outcome.kind === "result")).toHaveLength(2);
  });

  it("clearAllFailureStates resets every task type for the repository as one audit event", async () => {
    await service.record(taskRequest("sync"), { kind: "result", result: failureResult("sync") });
    await service.record(taskRequest("push-changes"), { kind: "result", result: failureResult("push-changes") });

    await service.clearAllFailureStates(REPOSITORY_ID);

    const states = await service.getAllFailureStates(REPOSITORY_ID);
    expect(states).toHaveLength(0);

    const events = await service.getRecentEvents({ repositoryId: REPOSITORY_ID, limit: 10 });
    const clearedEvents = events.filter((event) => event.outcome.kind === "failure-state-cleared");
    expect(clearedEvents).toHaveLength(1);
    expect((clearedEvents[0].outcome as { taskType?: string }).taskType).toBeUndefined();
  });

  it("no-ops (no persistence, no fabricated state) when memory is disabled", async () => {
    const disabledService = new ProjectMemoryService(fakeRegistry(), fakeConfigService(directory, false));
    await disabledService.record(taskRequest("sync"), { kind: "result", result: failureResult("sync") });

    const state = await disabledService.getFailureState(REPOSITORY_ID, "sync" as never);
    expect(state).toBeUndefined();
    await expect(readFile(path.join(directory, "failure-state.json"), "utf8")).rejects.toThrow();
  });

  it("does not lose an increment when two recordTaskOutcome calls race", async () => {
    await Promise.all([
      service.recordTaskOutcome(REPOSITORY_ID, "sync" as never, "failure"),
      service.recordTaskOutcome(REPOSITORY_ID, "sync" as never, "failure"),
    ]);
    const state = await service.getFailureState(REPOSITORY_ID, "sync" as never);
    expect(state?.consecutiveFailures).toBe(2);
  });
});

// Failure State Self-Healing: validateAndRepairFailureState() is the
// startup-time check -- must never throw, and must always leave a valid,
// schema-stamped file on disk afterward, however bad the file it found was.
describe("ProjectMemoryService — failure-state self-healing", () => {
  let directory: string;
  let service: ProjectMemoryService;
  let failureStatePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "project-memory-healing-"));
    service = new ProjectMemoryService(fakeRegistry(), fakeConfigService(directory));
    failureStatePath = path.join(directory, FAILURE_STATE_FILE_NAME);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("treats a missing failure-state.json as a normal, recoverable startup condition", async () => {
    const report = await service.validateAndRepairFailureState();
    expect(report).toEqual({ status: "rebuilt", reason: "missing", repositoriesRecovered: 0 });

    const written = JSON.parse(await readFile(failureStatePath, "utf8"));
    expect(written.schemaVersion).toBe(1);
    expect(typeof written.updatedAt).toBe("string");
    expect(written.repositories).toEqual({});
  });

  it("recovers from corrupted (invalid JSON) failure-state.json without throwing", async () => {
    await writeFile(failureStatePath, '{ "repositories": { "repo-1": { "sync": ', "utf8");

    const report = await service.validateAndRepairFailureState();
    expect(report.status).toBe("rebuilt");
    expect(report.reason).toBe("invalid-json");

    // Startup must be able to continue immediately afterward -- a normal
    // read no longer sees the corrupted file.
    expect(await service.getAllFailureStates(REPOSITORY_ID)).toEqual([]);
  });

  it("recovers from a schema mismatch (old pre-envelope bare-map format) without throwing", async () => {
    // The exact shape ProjectMemoryService wrote before this feature existed
    // -- no schemaVersion, no updatedAt, no "repositories" wrapper.
    await writeFile(failureStatePath, JSON.stringify({ [REPOSITORY_ID]: { sync: { repositoryId: REPOSITORY_ID, taskType: "sync", consecutiveFailures: 3, blocked: false } } }), "utf8");

    const report = await service.validateAndRepairFailureState();
    expect(report.status).toBe("rebuilt");
    expect(report.reason).toBe("schema-mismatch");
  });

  it("recovers from a partially-written (truncated) file without throwing", async () => {
    await writeFile(failureStatePath, '{"schemaVersion":1,"updatedAt":"2026-07-2', "utf8");
    const report = await service.validateAndRepairFailureState();
    expect(report.status).toBe("rebuilt");
    expect(report.reason).toBe("invalid-json");
  });

  it("leaves a valid, current-schema file untouched (status: valid, no rebuild)", async () => {
    await service.recordTaskOutcome(REPOSITORY_ID, "sync" as never, "failure");
    const beforeRaw = await readFile(failureStatePath, "utf8");

    const report = await service.validateAndRepairFailureState();
    expect(report).toEqual({ status: "valid" });

    const afterRaw = await readFile(failureStatePath, "utf8");
    expect(afterRaw).toBe(beforeRaw);
  });

  it("rebuilds correct consecutive-failure state from Project Memory history, including historical clears", async () => {
    // sync: fail, fail, fail (=3 consecutive)
    await service.record({ kind: "task", task: { type: "sync" } as never, repositoryId: REPOSITORY_ID }, { kind: "result", result: failureResult("sync") });
    await service.record({ kind: "task", task: { type: "sync" } as never, repositoryId: REPOSITORY_ID }, { kind: "result", result: failureResult("sync") });
    await service.record({ kind: "task", task: { type: "sync" } as never, repositoryId: REPOSITORY_ID }, { kind: "result", result: failureResult("sync") });

    // push-changes: fail x5 (blocked), then a manual clear, then fail once more (=1 consecutive again)
    for (let i = 0; i < 5; i++) {
      await service.record({ kind: "task", task: { type: "push-changes" } as never, repositoryId: REPOSITORY_ID }, { kind: "result", result: failureResult("push-changes") });
    }
    await service.clearFailureState(REPOSITORY_ID, "push-changes" as never);
    await service.record({ kind: "task", task: { type: "push-changes" } as never, repositoryId: REPOSITORY_ID }, { kind: "result", result: failureResult("push-changes") });

    // fix-bug: fail, then succeed (=0 consecutive, healthy again)
    await service.record({ kind: "task", task: { type: "fix-bug" } as never, repositoryId: REPOSITORY_ID }, { kind: "result", result: failureResult("fix-bug") });
    await service.record({ kind: "task", task: { type: "fix-bug" } as never, repositoryId: REPOSITORY_ID }, { kind: "result", result: successResult("fix-bug") });

    // Corrupt the derived file, forcing a rebuild purely from events.jsonl.
    await writeFile(failureStatePath, "not json at all", "utf8");

    const report = await service.validateAndRepairFailureState();
    expect(report.status).toBe("rebuilt");
    expect(report.repositoriesRecovered).toBe(1);

    const sync = await service.getFailureState(REPOSITORY_ID, "sync" as never);
    expect(sync?.consecutiveFailures).toBe(3);
    expect(sync?.blocked).toBe(false);

    const pushChanges = await service.getFailureState(REPOSITORY_ID, "push-changes" as never);
    expect(pushChanges?.consecutiveFailures).toBe(1);
    expect(pushChanges?.blocked).toBe(false);

    const fixBug = await service.getFailureState(REPOSITORY_ID, "fix-bug" as never);
    expect(fixBug?.consecutiveFailures).toBe(0);
    expect(fixBug?.blocked).toBe(false);
  });

  it("is a no-op when memory is disabled", async () => {
    const disabledService = new ProjectMemoryService(fakeRegistry(), fakeConfigService(directory, false));
    const report = await disabledService.validateAndRepairFailureState();
    expect(report).toEqual({ status: "skipped-memory-disabled" });
  });
});

// Branch Blocking Observability: recordPipelineBlock() is a pure audit
// write -- it must append to events.jsonl (so investigations can find it)
// but must never touch failure-state.json, never count as a task
// success/failure, and must never surface through the self-healing rebuild
// as a task-type record.
describe("ProjectMemoryService — pipeline-blocked audit events", () => {
  let directory: string;
  let service: ProjectMemoryService;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "project-memory-blocked-"));
    service = new ProjectMemoryService(fakeRegistry(), fakeConfigService(directory));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("appends a retrievable pipeline-blocked event", async () => {
    await service.recordPipelineBlock(REPOSITORY_ID, {
      taskType: "fix-bug" as never,
      pipelineStage: "BranchManagement" as never,
      blockingReason: "current branch equals default branch",
      currentBranch: "production_2026_mall",
      defaultBranch: "production_2026_mall",
      recommendedAction: "switch to an implementation branch",
      decisionSummary: "StrategyEngine recommended CreateFeatureBranch",
    });

    const events = await service.getRecentEvents({ repositoryId: REPOSITORY_ID, limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0].outcome.kind).toBe("pipeline-blocked");
    if (events[0].outcome.kind === "pipeline-blocked") {
      expect(events[0].outcome.currentBranch).toBe("production_2026_mall");
      expect(events[0].outcome.pipelineStage).toBe("BranchManagement");
    }
  });

  it("never affects failure-state consecutive counters", async () => {
    await service.record(taskRequest("fix-bug"), { kind: "result", result: failureResult("fix-bug") });
    await service.recordPipelineBlock(REPOSITORY_ID, {
      taskType: "fix-bug" as never,
      pipelineStage: "BranchManagement" as never,
      blockingReason: "x",
      currentBranch: "a",
      defaultBranch: "b",
      recommendedAction: "y",
      decisionSummary: "z",
    });

    const state = await service.getFailureState(REPOSITORY_ID, "fix-bug" as never);
    expect(state?.consecutiveFailures).toBe(1); // unchanged by the audit event
  });

  it("is invisible to the self-healing rebuild (never produces a TaskFailureState)", async () => {
    await service.recordPipelineBlock(REPOSITORY_ID, {
      taskType: "sync" as never,
      pipelineStage: "HumanReview" as never,
      blockingReason: "x",
      currentBranch: "a",
      defaultBranch: "b",
      recommendedAction: "y",
      decisionSummary: "z",
    });

    // failure-state.json doesn't exist yet in this fresh directory -- the
    // rebuild it triggers must recover zero repositories from the single
    // pipeline-blocked event, since that event kind carries no TaskFailureState.
    const report = await service.validateAndRepairFailureState();
    expect(report).toEqual({ status: "rebuilt", reason: "missing", repositoriesRecovered: 0 });
    expect(await service.getAllFailureStates(REPOSITORY_ID)).toEqual([]);
  });
});
