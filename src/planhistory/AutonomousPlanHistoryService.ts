import { appendFile, mkdir, open } from "node:fs/promises";
import path from "node:path";
import type { AutonomousPlan } from "../autonomy/types";
import type { IConfigService } from "../config/interfaces";
import type { IAutonomousPlanEvolutionEngine, IAutonomousPlanHistoryService } from "./interfaces";
import type { AutonomousPlanHistoryEntry } from "./types";

const HISTORY_FILE_NAME = "autonomous-plans.jsonl";
const DEFAULT_HISTORY_LIMIT = 20;

// How much of the file's tail to pull per backward read. Deliberately not
// "read everything" — this is what makes readTailLines() cost proportional
// to the number of lines actually requested, not to total accumulated
// history, no matter how large the file grows. A single record's JSON is
// expected to be well under this; if one ever exceeds it, the loop below
// simply reads another chunk further back, so correctness never depends on
// a line fitting in one chunk.
const TAIL_READ_CHUNK_BYTES = 64 * 1024;

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
// written. As of Phase 10, its one caller is AutonomousPlanRecordingService
// (src/planrecording), reached from live code via
// ApplicationService.recordAutonomousPlanCycle() — nothing invokes that
// method automatically yet, so deciding when a cycle should actually be
// recorded on an ongoing basis remains a future runtime/scheduler phase's
// decision, same as always; Phase 10 only made the write itself explicit
// and callable.
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

  // Phase 10.2: reads only the newest line via readTailLines(path, 1) — never
  // calls getHistory(), never scans lines earlier than the one it needs.
  // record() calls this on every write, so its cost must stay independent of
  // total accumulated history — see readTailLines()'s own doc comment.
  async getLatestEntry(): Promise<AutonomousPlanHistoryEntry | undefined> {
    const [latest] = await this.readTailLines(this.historyFilePath(this.historyDirectory()), 1);
    return latest ? (JSON.parse(latest, reviveDates) as AutonomousPlanHistoryEntry) : undefined;
  }

  // Phase 10.2: reads only the newest `limit` lines from the end of the
  // file — cost proportional to `limit`, never to total accumulated
  // history. Returned data is byte-for-byte identical to the previous
  // whole-file-scan implementation (same reviver, same newest-first
  // ordering, same slice semantics for limit=0 and for a history smaller
  // than limit) — only how those lines are read off disk has changed.
  async getHistory(limit?: number): Promise<AutonomousPlanHistoryEntry[]> {
    const effectiveLimit = limit ?? DEFAULT_HISTORY_LIMIT;
    if (effectiveLimit <= 0) {
      return [];
    }

    const lines = await this.readTailLines(this.historyFilePath(this.historyDirectory()), effectiveLimit);
    // readTailLines() returns lines in file (oldest-first) order; getHistory()
    // has always returned newest-first, so this reverse reproduces exactly
    // what the old "read everything, then .reverse()" implementation did.
    return lines.map((line) => JSON.parse(line, reviveDates) as AutonomousPlanHistoryEntry).reverse();
  }

  // The one place this class reads its own file backward instead of
  // forward. Returns up to `count` of the newest non-empty lines, in
  // chronological (oldest-first) order, as raw unparsed strings — callers
  // parse and reorder as their own contract requires. Reads the file in
  // fixed-size chunks starting from the end, prepending each chunk to what's
  // already been read, and stops as soon as either enough lines have been
  // seen or the start of the file has been reached — so its cost is bounded
  // by `count` (plus, in the worst case, one line's own size), never by how
  // large the file has grown. A file with fewer than `count` entries simply
  // returns every entry it has, same as Array.prototype.slice already did
  // for the old implementation's equivalent case.
  //
  // Never deletes, truncates, or rewrites anything — this is a read-only
  // technique for answering "what are the newest N records" cheaply; the
  // file itself keeps accumulating every recorded cycle forever, exactly as
  // before.
  private async readTailLines(filePath: string, count: number): Promise<string[]> {
    let handle;
    try {
      handle = await open(filePath, "r");
    } catch (error) {
      if (this.isFileNotFoundError(error)) {
        return [];
      }
      throw error;
    }

    try {
      const { size } = await handle.stat();
      let position = size;
      let accumulated = "";
      const buffer = Buffer.alloc(TAIL_READ_CHUNK_BYTES);

      while (position > 0) {
        const chunkSize = Math.min(TAIL_READ_CHUNK_BYTES, position);
        position -= chunkSize;
        const { bytesRead } = await handle.read(buffer, 0, chunkSize, position);
        accumulated = buffer.toString("utf8", 0, bytesRead) + accumulated;

        const nonEmptyLineCount = accumulated.split("\n").filter((line) => line.trim().length > 0).length;
        // Stops once strictly more than `count` non-empty lines are visible
        // (never exactly `count`): a chunk boundary can land mid-line, so an
        // exact match could still be missing part of the earliest line it
        // needs — one extra guarantees every line the final slice keeps is
        // known-complete. Reaching the start of the file (position === 0)
        // always stops the loop regardless, since there is nothing earlier
        // left to read.
        if (nonEmptyLineCount > count || position === 0) {
          break;
        }
      }

      const lines = accumulated
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      return lines.slice(Math.max(0, lines.length - count));
    } finally {
      await handle.close();
    }
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
