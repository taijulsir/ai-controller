import { randomUUID } from "node:crypto";
import { JournalEntryNotFoundError } from "./errors";
import type { IJournalStorage, IOperationJournal } from "./interfaces";
import type { JournalEntry, JournalQuery } from "./types";

export class OperationJournal implements IOperationJournal {
  constructor(private readonly storage: IJournalStorage) {}

  async record(entry: Omit<JournalEntry, "id">): Promise<JournalEntry> {
    const fullEntry: JournalEntry = { ...entry, id: randomUUID() };
    await this.storage.append(fullEntry);
    return fullEntry;
  }

  async update(
    id: string,
    patch: Partial<Pick<JournalEntry, "status" | "afterRef" | "completedAt" | "error">>,
  ): Promise<JournalEntry> {
    const existing = await this.getById(id);
    if (!existing) {
      throw new JournalEntryNotFoundError(id);
    }
    const updated: JournalEntry = { ...existing, ...patch };
    await this.storage.overwrite(updated);
    return updated;
  }

  async query(query: JournalQuery): Promise<JournalEntry[]> {
    return this.storage.query(query);
  }

  async getMostRecent(repositoryId: string): Promise<JournalEntry | undefined> {
    const [mostRecent] = await this.storage.query({ repositoryId, limit: 1 });
    return mostRecent;
  }

  async getById(id: string): Promise<JournalEntry | undefined> {
    const [entry] = await this.storage.query({ id });
    return entry;
  }
}
