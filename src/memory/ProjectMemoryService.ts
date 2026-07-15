import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { IConfigService } from "../config/interfaces";
import type { ExecutionRequest } from "../controller/types";
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
    const memoryConfig = this.configService.getControllerConfig().memory;
    if (!memoryConfig.enabled) {
      return;
    }

    const event: ProjectMemoryEvent = {
      id: randomUUID(),
      recordedAt: new Date(),
      repositoryId: this.resolveRepositoryId(request),
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
