import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IJournalStorage } from "./interfaces";
import { JournalEntryNotFoundError } from "./errors";
import type { JournalEntry, JournalQuery } from "./types";

// Same round-trip technique as src/artifacts/ArtifactIndex.ts's own date
// reviver -- matches the ISO-8601 strings JSON.stringify produces for a
// Date, so a parse reviver can restore startedAt/completedAt without
// knowing the rest of the shape.
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function reviveDates(_key: string, value: unknown): unknown {
  if (typeof value === "string" && ISO_DATE_PATTERN.test(value)) {
    return new Date(value);
  }
  return value;
}

// One JSONL file per repository -- append() is a single fs.writeFile in
// "a" mode (one line), matching the journal's expected low write volume (one
// entry per mutating git command, not per artifact-scale traffic).
// overwrite() is the journal's only in-place mutation: read the whole file,
// replace the one matching line, write the file back -- acceptable at this
// volume, the same tradeoff src/artifacts' ArtifactIndex makes by rebuilding
// entirely from disk on restart rather than maintaining a durable index.
export class FilesystemJournalStorage implements IJournalStorage {
  constructor(private readonly baseDirectory: string) {}

  async append(entry: JournalEntry): Promise<void> {
    await mkdir(this.baseDirectory, { recursive: true });
    const line = `${JSON.stringify(entry)}\n`;
    await writeFile(this.resolveRepositoryFile(entry.repositoryId), line, { flag: "a" });
  }

  async overwrite(entry: JournalEntry): Promise<void> {
    const filePath = this.resolveRepositoryFile(entry.repositoryId);
    const entries = await this.readFile(filePath);
    const index = entries.findIndex((candidate) => candidate.id === entry.id);
    if (index === -1) {
      throw new JournalEntryNotFoundError(entry.id);
    }
    entries[index] = entry;
    await mkdir(this.baseDirectory, { recursive: true });
    await writeFile(filePath, entries.map((candidate) => `${JSON.stringify(candidate)}\n`).join(""));
  }

  async query(query: JournalQuery): Promise<JournalEntry[]> {
    const entries = query.repositoryId
      ? await this.readFile(this.resolveRepositoryFile(query.repositoryId))
      : await this.readAllFiles();

    const filtered = entries
      .filter((entry) => !query.id || entry.id === query.id)
      .filter((entry) => !query.operation || entry.operation === query.operation)
      .filter((entry) => !query.status || entry.status === query.status)
      .filter((entry) => !query.since || entry.startedAt.getTime() >= query.since.getTime())
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

    return query.limit ? filtered.slice(0, query.limit) : filtered;
  }

  private async readAllFiles(): Promise<JournalEntry[]> {
    let fileNames: string[];
    try {
      fileNames = await readdir(this.baseDirectory);
    } catch {
      return [];
    }
    const results = await Promise.all(
      fileNames.filter((name) => name.endsWith(".jsonl")).map((name) => this.readFile(path.join(this.baseDirectory, name))),
    );
    return results.flat();
  }

  private async readFile(filePath: string): Promise<JournalEntry[]> {
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      return [];
    }
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line, reviveDates) as JournalEntry);
  }

  // Every repository id in this codebase is a simple config-defined slug
  // (see config/repositories.yaml) -- still resolved and range-checked
  // against baseDirectory, the same path-safety precedent
  // FilesystemStorage.resolvePath() already established for artifacts, so a
  // pathological id can never escape the journal directory.
  private resolveRepositoryFile(repositoryId: string): string {
    const resolved = path.resolve(this.baseDirectory, `${repositoryId}.jsonl`);
    const relative = path.relative(this.baseDirectory, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Journal repository id escapes base directory: ${repositoryId}`);
    }
    return resolved;
  }
}
