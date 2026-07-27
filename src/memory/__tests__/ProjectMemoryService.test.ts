import { mkdtemp, readFile, rm } from "node:fs/promises";
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
