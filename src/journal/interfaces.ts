import type { JournalEntry, JournalQuery } from "./types";

export interface IOperationJournal {
  record(entry: Omit<JournalEntry, "id">): Promise<JournalEntry>;
  update(
    id: string,
    patch: Partial<Pick<JournalEntry, "status" | "afterRef" | "completedAt" | "error">>,
  ): Promise<JournalEntry>;
  query(query: JournalQuery): Promise<JournalEntry[]>;
  getMostRecent(repositoryId: string): Promise<JournalEntry | undefined>;
  // Deviation from the Phase 0 freeze, noted in the implementation report:
  // added once Safe Undo Framework needed to re-fetch one specific entry
  // (by the id a prior, separate request already handed back) without
  // knowing its repositoryId up front.
  getById(id: string): Promise<JournalEntry | undefined>;
}

// Storage abstraction -- mirrors src/artifacts/storage/interfaces.ts's own
// split between "what a consumer needs" (IOperationJournal) and "how bytes
// get persisted" (this interface), so an in-memory test double and a real
// filesystem backend can both satisfy it without either leaking into the
// other's concerns.
export interface IJournalStorage {
  append(entry: JournalEntry): Promise<void>;
  // Rewrites the one entry matching entry.id in place -- the journal's only
  // mutation path, used by IOperationJournal.update().
  overwrite(entry: JournalEntry): Promise<void>;
  query(query: JournalQuery): Promise<JournalEntry[]>;
}
