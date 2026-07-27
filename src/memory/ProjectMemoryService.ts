import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IConfigService } from "../config/interfaces";
import type { ExecutionRequest } from "../controller/types";
import type { ExecutionCheckpoint, TaskType } from "../planner/types";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import type { IProjectMemoryService } from "./interfaces";
import type { ProjectMemoryEvent, ProjectMemoryOutcome, TaskFailureState } from "./types";

const EVENTS_FILE_NAME = "events.jsonl";
const FAILURE_STATE_FILE_NAME = "failure-state.json";
const DEFAULT_RECENT_EVENTS_LIMIT = 20;

// Repository Failure Policy redesign: consecutiveFailures >= this value marks
// a TaskFailureState blocked. Lives here, not in DecisionEngine, because this
// is the one place consecutiveFailures is actually incremented/reset --
// "blocked" must be derived at the exact point the count changes, never
// recomputed elsewhere, so it can never drift out of sync with the count it
// reflects. DecisionEngine imports this same constant for its own severity
// split (critical once blocked) rather than redeclaring the number.
export const FAILURE_BLOCK_THRESHOLD = 5;

// repositoryId -> taskType -> state. A plain nested map (not the flat array
// events.jsonl uses) since this is current derived state, not an append-only
// log -- O(1) keyed access is what every read/write here actually needs.
type FailureStateFile = Record<string, Record<string, TaskFailureState>>;

// Matches the ISO-8601 strings produced by Date.prototype.toJSON() (what
// JSON.stringify uses for Date values), so a parse reviver can round-trip
// every Date field nested anywhere inside a stored ExecutionResult without
// needing to know its exact shape.
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function reviveDates(_key: string, value: unknown): unknown {
  if (typeof value === "string" && ISO_DATE_PATTERN.test(value)) {
    return new Date(value);
  }
  return value;
}

export class ProjectMemoryService implements IProjectMemoryService {
  // Repository Failure Policy redesign: serializes every failure-state
  // read-modify-write cycle within this one Node process. Necessary because
  // MemoryRecordingControllerCore records outcomes fire-and-forget (never
  // awaited, see its own doc comment) -- without this, two executions
  // completing close together could interleave their read-modify-write
  // cycles and silently lose an increment. Only guards against concurrency
  // within this one process; this app is deployed single-instance (PM2 or
  // systemd, per DEPLOYMENT.md/ecosystem.config.js), so that's the only
  // concurrency that can actually occur -- a second OS process writing the
  // same file is an accepted, out-of-scope residual risk, not a supported
  // topology.
  private failureStateWriteQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly repositoryRegistry: IRepositoryRegistry,
    private readonly configService: IConfigService,
  ) {}

  async record(request: ExecutionRequest, outcome: ProjectMemoryOutcome): Promise<void> {
    await this.appendEvent(this.resolveRepositoryId(request), outcome);
    await this.updateFailureStateFromOutcome(request, outcome);
  }

  // Repository Failure Policy redesign: the one place a real execution's
  // outcome turns into a consecutive-failure count. Only "task"-kind
  // requests participate -- workflows have no single task-type identity to
  // key a per-task-type counter off (see DecisionEngine's own doc comment on
  // why workflow-keyed repeated-failure detection stays on the old,
  // unchanged event-scan path instead). "undo"/"failure-state-cleared"
  // outcomes never reach here either -- neither represents a task actually
  // running.
  //
  // Deliberate behavior change from the old event-scan detector: a thrown
  // error (outcome.kind === "error") now counts as a failure. The old
  // detector couldn't -- it only ever saw a bare error string reconstructed
  // from a stored ProjectMemoryEvent, with no task type attached. This
  // method reads request.task.type directly, before the outcome is even
  // inspected, so that limitation no longer applies -- and "task failed"
  // from a user's perspective plainly includes a thrown error.
  private async updateFailureStateFromOutcome(request: ExecutionRequest, outcome: ProjectMemoryOutcome): Promise<void> {
    if (request.kind !== "task") {
      return;
    }
    if (outcome.kind !== "result" && outcome.kind !== "error") {
      return;
    }
    const repositoryId = this.resolveRepositoryId(request);
    if (!repositoryId) {
      return;
    }
    const succeeded = outcome.kind === "result" && outcome.result.kind === "task" && outcome.result.taskResult.success;
    await this.recordTaskOutcome(repositoryId, request.task.type, succeeded ? "success" : "failure");
  }

  // IFailureStateStore's write methods. recordTaskOutcome is the only method
  // that ever increments/resets consecutiveFailures -- "blocked" is derived
  // right here, at the exact moment the count changes, never stored
  // independently.
  async recordTaskOutcome(repositoryId: string, taskType: TaskType, outcome: "success" | "failure"): Promise<TaskFailureState> {
    const memoryConfig = this.configService.getControllerConfig().memory;
    if (!memoryConfig.enabled) {
      // Same "no persistence, nothing to report" contract appendEvent()
      // already has when memory is disabled -- no fabricated count, no
      // fabricated blocked state, just the honest "nothing is being tracked"
      // fact.
      return { repositoryId, taskType, consecutiveFailures: 0, blocked: false };
    }

    return this.withFailureStateLock(async () => {
      const file = await this.readFailureStateFile(memoryConfig.directory);
      const existing = file[repositoryId]?.[taskType];
      const now = new Date();

      const nextState: TaskFailureState =
        outcome === "success"
          ? { repositoryId, taskType, consecutiveFailures: 0, lastFailure: existing?.lastFailure, lastSuccess: now, blocked: false }
          : {
              repositoryId,
              taskType,
              consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
              lastFailure: now,
              lastSuccess: existing?.lastSuccess,
              blocked: (existing?.consecutiveFailures ?? 0) + 1 >= FAILURE_BLOCK_THRESHOLD,
            };

      file[repositoryId] = { ...file[repositoryId], [taskType]: nextState };
      await this.writeFailureStateFile(memoryConfig.directory, file);
      return nextState;
    });
  }

  // IFailureStateReader's two methods. No memory.enabled check of their own
  // -- same reasoning getRecentEvents() below already relies on: when memory
  // is disabled, recordTaskOutcome() above never persists anything, so the
  // file simply never exists and readFailureStateFile() naturally returns
  // {} via the same ENOENT-means-empty path getRecentEvents() already uses.
  async getFailureState(repositoryId: string, taskType: TaskType): Promise<TaskFailureState | undefined> {
    const memoryConfig = this.configService.getControllerConfig().memory;
    const file = await this.readFailureStateFile(memoryConfig.directory);
    return file[repositoryId]?.[taskType];
  }

  async getAllFailureStates(repositoryId: string): Promise<TaskFailureState[]> {
    const memoryConfig = this.configService.getControllerConfig().memory;
    const file = await this.readFailureStateFile(memoryConfig.directory);
    return Object.values(file[repositoryId] ?? {});
  }

  // /clear-failures sync -- resets one task type's counter. Always appends a
  // "failure-state-cleared" audit event via the same appendEvent() every
  // other write in this file shares (which itself already no-ops when memory
  // is disabled), regardless of whether there was anything to clear, so the
  // Telegram command always confirms plainly rather than silently doing
  // nothing when memory happens to be off.
  async clearFailureState(repositoryId: string, taskType: TaskType): Promise<void> {
    const memoryConfig = this.configService.getControllerConfig().memory;
    if (memoryConfig.enabled) {
      await this.withFailureStateLock(async () => {
        const file = await this.readFailureStateFile(memoryConfig.directory);
        if (file[repositoryId]) {
          delete file[repositoryId][taskType];
        }
        await this.writeFailureStateFile(memoryConfig.directory, file);
      });
    }
    await this.appendEvent(repositoryId, { kind: "failure-state-cleared", taskType });
  }

  // /clear-failures (bare) -- resets every task type at once for the
  // repository, as one audit event (taskType: undefined), not N.
  async clearAllFailureStates(repositoryId: string): Promise<void> {
    const memoryConfig = this.configService.getControllerConfig().memory;
    if (memoryConfig.enabled) {
      await this.withFailureStateLock(async () => {
        const file = await this.readFailureStateFile(memoryConfig.directory);
        delete file[repositoryId];
        await this.writeFailureStateFile(memoryConfig.directory, file);
      });
    }
    await this.appendEvent(repositoryId, { kind: "failure-state-cleared" });
  }

  private async withFailureStateLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.failureStateWriteQueue.then(fn, fn);
    this.failureStateWriteQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readFailureStateFile(directory: string): Promise<FailureStateFile> {
    try {
      const contents = await readFile(this.failureStateFilePath(directory), "utf8");
      return JSON.parse(contents, reviveDates) as FailureStateFile;
    } catch (error) {
      if (this.isFileNotFoundError(error)) {
        return {};
      }
      throw error;
    }
  }

  private async writeFailureStateFile(directory: string, file: FailureStateFile): Promise<void> {
    await mkdir(directory, { recursive: true });
    await writeFile(this.failureStateFilePath(directory), JSON.stringify(file), "utf8");
  }

  private failureStateFilePath(directory: string): string {
    return path.join(directory, FAILURE_STATE_FILE_NAME);
  }

  // IUndoRecorder's one method: appends the "undo" outcome the same way
  // record() appends every other one -- a plain, ordered fact added to the
  // same log, never a mutation of the checkpoint's own original event.
  async recordUndo(repositoryId: string, undoneCheckpointId: string): Promise<void> {
    await this.appendEvent(repositoryId, { kind: "undo", undoneCheckpointId });
  }

  // IUndoableExecutionHistoryProvider's one method. Reuses getRecentEvents()
  // itself (already reverse-chronological, i.e. newest first) rather than
  // re-reading/re-parsing the file a second way -- a large limit simply means
  // "don't stop before scanning the whole history for this repository."
  // Walking newest-to-oldest, an "undo" event is always encountered *before*
  // the checkpoint event it refers to (undoing necessarily happens after a
  // checkpoint exists), so collecting undone ids as they're seen and
  // checking that set before returning a checkpoint is enough to skip
  // anything already undone -- no second pass needed.
  async getMostRecentUndoableExecution(repositoryId: string): Promise<ExecutionCheckpoint | undefined> {
    const events = await this.getRecentEvents({ repositoryId, limit: Number.MAX_SAFE_INTEGER });
    const undoneCheckpointIds = new Set<string>();

    for (const event of events) {
      if (event.outcome.kind === "undo") {
        undoneCheckpointIds.add(event.outcome.undoneCheckpointId);
        continue;
      }
      if (event.outcome.kind !== "result" || event.outcome.result.kind !== "task") {
        continue;
      }
      const { checkpoint } = event.outcome.result.taskResult;
      if (checkpoint && !undoneCheckpointIds.has(checkpoint.id)) {
        return checkpoint;
      }
    }

    return undefined;
  }

  private async appendEvent(repositoryId: string | undefined, outcome: ProjectMemoryOutcome): Promise<void> {
    const memoryConfig = this.configService.getControllerConfig().memory;
    if (!memoryConfig.enabled) {
      return;
    }

    const event: ProjectMemoryEvent = {
      id: randomUUID(),
      recordedAt: new Date(),
      repositoryId,
      outcome,
    };

    await mkdir(memoryConfig.directory, { recursive: true });
    await appendFile(this.eventsFilePath(memoryConfig.directory), `${JSON.stringify(event)}\n`, "utf8");
  }

  async getRecentEvents(options: { repositoryId?: string; limit?: number } = {}): Promise<ProjectMemoryEvent[]> {
    const memoryConfig = this.configService.getControllerConfig().memory;

    let contents: string;
    try {
      contents = await readFile(this.eventsFilePath(memoryConfig.directory), "utf8");
    } catch (error) {
      if (this.isFileNotFoundError(error)) {
        return [];
      }
      throw error;
    }

    const events = contents
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line, reviveDates) as ProjectMemoryEvent)
      .filter((event) => !options.repositoryId || event.repositoryId === options.repositoryId)
      .reverse();

    return events.slice(0, options.limit ?? DEFAULT_RECENT_EVENTS_LIMIT);
  }

  private resolveRepositoryId(request: ExecutionRequest): string | undefined {
    return request.repositoryId ?? this.repositoryRegistry.getActiveRepository()?.id;
  }

  private eventsFilePath(directory: string): string {
    return path.join(directory, EVENTS_FILE_NAME);
  }

  private isFileNotFoundError(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
  }
}
