import type { IJournalStorage } from "../interfaces";
import { JournalEntryNotFoundError } from "../errors";
import type { JournalEntry, JournalQuery } from "../types";

// Test-only IJournalStorage implementation -- backs OperationJournal unit
// tests with no disk I/O, same role InMemoryStorage plays for
// src/artifacts/__tests__.
export class InMemoryJournalStorage implements IJournalStorage {
  private readonly entries: JournalEntry[] = [];

  async append(entry: JournalEntry): Promise<void> {
    this.entries.push(entry);
  }

  async overwrite(entry: JournalEntry): Promise<void> {
    const index = this.entries.findIndex((candidate) => candidate.id === entry.id);
    if (index === -1) {
      throw new JournalEntryNotFoundError(entry.id);
    }
    this.entries[index] = entry;
  }

  async query(query: JournalQuery): Promise<JournalEntry[]> {
    const filtered = this.entries
      .filter((entry) => !query.id || entry.id === query.id)
      .filter((entry) => !query.repositoryId || entry.repositoryId === query.repositoryId)
      .filter((entry) => !query.operation || entry.operation === query.operation)
      .filter((entry) => !query.status || entry.status === query.status)
      .filter((entry) => !query.since || entry.startedAt.getTime() >= query.since.getTime())
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

    return query.limit ? filtered.slice(0, query.limit) : filtered;
  }
}
