import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AutonomousPlan } from "../autonomy/types";
import type { IConfigService } from "../config/interfaces";
import type { IAutonomousPlanEvolutionEngine, IAutonomousPlanHistoryService } from "./interfaces";
import type { AutonomousPlanHistoryEntry } from "./types";

const HISTORY_FILE_NAME = "autonomous-plans.jsonl";
const DEFAULT_HISTORY_LIMIT = 20;

// Matches ProjectMemoryService's own reviver — the ISO-8601 strings
// Date.prototype.toJSON() produces (what JSON.stringify uses for Date
// values) — so every Date field nested anywhere inside a stored
// AutonomousPlanHistoryEntry round-trips without needing to know its exact
// shape.
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function reviveDates(_key: string, value: unknown): unknown {
  if (typeof value === "string" && ISO_DATE_PATTERN.test(value)) {
    return new Date(value);
  }
  return value;
}

// The one class that owns this storage location — mirrors
// ProjectMemoryService's own append/read-back shape exactly, but a distinct
// file (autonomous-plans.jsonl, never events.jsonl): a plan-cycle snapshot
// and an execution-event record mean different things and must never be
// interleaved in one log. Reuses ControllerConfig.memory.directory as the
// base path — the same already-validated, already-configurable directory
// Project Memory writes to — rather than introducing a new required YAML
// section for a capability nothing calls yet; same "kept internal for now"
// precedent RuntimePolicyEngine's own defaults already established.
//
// Also the one class permitted to invoke IAutonomousPlanEvolutionEngine:
// recording and evolution computation are inseparable (the evolution for a
// cycle is a historical fact fixed at the moment that cycle is recorded, not
// something recomputed later), so this service, not ApplicationService,
// owns calling it. record() is the only place a planning cycle is ever
// written — nothing in this phase calls it; it is exercised only by its own
// verification script, ready for a future runtime/scheduler phase to decide
// when a cycle should actually be recorded.
export class AutonomousPlanHistoryService implements IAutonomousPlanHistoryService {
  constructor(
    private readonly configService: IConfigService,
    private readonly evolutionEngine: IAutonomousPlanEvolutionEngine,
  ) {}

  async record(plan: AutonomousPlan): Promise<AutonomousPlanHistoryEntry> {
    const previous = await this.getLatestEntry();
    const cycleNumber = previous ? previous.cycleNumber + 1 : 1;
    const evolution = this.evolutionEngine.analyze(previous, plan, cycleNumber);

    const entry: AutonomousPlanHistoryEntry = {
      cycleNumber,
      recordedAt: new Date(),
      plan,
      evolution,
    };

    const directory = this.historyDirectory();
    await mkdir(directory, { recursive: true });
    await appendFile(this.historyFilePath(directory), `${JSON.stringify(entry)}\n`, "utf8");

    return entry;
  }

  async getLatestEntry(): Promise<AutonomousPlanHistoryEntry | undefined> {
    const [latest] = await this.getHistory(1);
    return latest;
  }

  async getHistory(limit?: number): Promise<AutonomousPlanHistoryEntry[]> {
    let contents: string;
    try {
      contents = await readFile(this.historyFilePath(this.historyDirectory()), "utf8");
    } catch (error) {
      if (this.isFileNotFoundError(error)) {
        return [];
      }
      throw error;
    }

    const entries = contents
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line, reviveDates) as AutonomousPlanHistoryEntry)
      .reverse();

    return entries.slice(0, limit ?? DEFAULT_HISTORY_LIMIT);
  }

  private historyDirectory(): string {
    return this.configService.getControllerConfig().memory.directory;
  }

  private historyFilePath(directory: string): string {
    return path.join(directory, HISTORY_FILE_NAME);
  }

  private isFileNotFoundError(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
  }
}
