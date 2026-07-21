import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { IConfigService } from "../config/interfaces";
import type { ExecutionRequest } from "../controller/types";
import type { ExecutionCheckpoint } from "../planner/types";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import type { IProjectMemoryService } from "./interfaces";
import type { ProjectMemoryEvent, ProjectMemoryOutcome } from "./types";

const EVENTS_FILE_NAME = "events.jsonl";
const DEFAULT_RECENT_EVENTS_LIMIT = 20;

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
  constructor(
    private readonly repositoryRegistry: IRepositoryRegistry,
    private readonly configService: IConfigService,
  ) {}

  async record(request: ExecutionRequest, outcome: ProjectMemoryOutcome): Promise<void> {
    await this.appendEvent(this.resolveRepositoryId(request), outcome);
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
