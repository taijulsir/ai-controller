import { describe, expect, it } from "vitest";
import type { IApprovalGate } from "../../gitorchestration/interfaces";
import type { IOperationJournal } from "../../journal/interfaces";
import { JournalEntryStatus, JournalOperationType, type JournalEntry, type JournalQuery } from "../../journal/types";
import type { IRepositoryRegistry } from "../../repositories/interfaces";
import { SafeUndoFramework } from "../SafeUndoFramework";

function fakeJournal(entries: JournalEntry[]): IOperationJournal {
  return {
    record: async (entry) => {
      const full: JournalEntry = { ...entry, id: "generated" };
      entries.push(full);
      return full;
    },
    update: async (id, patch) => {
      const existing = entries.find((entry) => entry.id === id)!;
      Object.assign(existing, patch);
      return existing;
    },
    query: async (query: JournalQuery) => {
      let results = entries;
      if (query.id !== undefined) results = results.filter((entry) => entry.id === query.id);
      if (query.repositoryId !== undefined) results = results.filter((entry) => entry.repositoryId === query.repositoryId);
      if (query.status !== undefined) results = results.filter((entry) => entry.status === query.status);
      results = [...results].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
      return query.limit !== undefined ? results.slice(0, query.limit) : results;
    },
    getMostRecent: async (repositoryId) => entries.filter((entry) => entry.repositoryId === repositoryId)[0],
    getById: async (id) => entries.find((entry) => entry.id === id),
  };
}

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: "entry-1",
    repositoryId: "repo-1",
    correlationId: "corr-1",
    operation: JournalOperationType.Commit,
    status: JournalEntryStatus.Completed,
    rollbackStrategy: "reset-soft",
    beforeRef: "before-sha",
    afterRef: "after-sha",
    startedAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: new Date("2026-01-01T00:01:00Z"),
    error: undefined,
    metadata: {},
    ...overrides,
  };
}

const noRegistry = {} as IRepositoryRegistry;
const alwaysApprove: IApprovalGate = { requestApproval: async () => true };
const alwaysDeny: IApprovalGate = { requestApproval: async () => false };

describe("SafeUndoFramework.buildUndoPlan", () => {
  it("returns undefined when nothing completed exists for the repository", async () => {
    const framework = new SafeUndoFramework(fakeJournal([]), noRegistry, {} as never, alwaysApprove);
    expect(await framework.buildUndoPlan("repo-1")).toBeUndefined();
  });

  it("returns undefined for a read-only entry (fetch)", async () => {
    const entries = [makeEntry({ rollbackStrategy: "read-only", operation: JournalOperationType.Fetch })];
    const framework = new SafeUndoFramework(fakeJournal(entries), noRegistry, {} as never, alwaysApprove);
    expect(await framework.buildUndoPlan("repo-1")).toBeUndefined();
  });

  it("builds a plan carrying the entry's own persisted rollback strategy verbatim", async () => {
    const entries = [makeEntry({ rollbackStrategy: "reset-soft" })];
    const framework = new SafeUndoFramework(fakeJournal(entries), noRegistry, {} as never, alwaysApprove);
    const plan = await framework.buildUndoPlan("repo-1");
    expect(plan).toMatchObject({ journalEntryId: "entry-1", strategy: "reset-soft", requiresApproval: false });
  });

  it("flags requiresApproval only for revert-and-force-push-with-lease", async () => {
    const entries = [makeEntry({ rollbackStrategy: "revert-and-force-push-with-lease", operation: JournalOperationType.Push })];
    const framework = new SafeUndoFramework(fakeJournal(entries), noRegistry, {} as never, alwaysApprove);
    const plan = await framework.buildUndoPlan("repo-1");
    expect(plan!.requiresApproval).toBe(true);
  });

  it("ignores entries that are not yet Completed", async () => {
    const entries = [makeEntry({ status: JournalEntryStatus.InProgress })];
    const framework = new SafeUndoFramework(fakeJournal(entries), noRegistry, {} as never, alwaysApprove);
    expect(await framework.buildUndoPlan("repo-1")).toBeUndefined();
  });
});

describe("SafeUndoFramework.executeUndoPlan", () => {
  it("refuses (throws AlreadyPushedError) when the approval gate denies a requires-approval undo", async () => {
    const entries = [makeEntry({ rollbackStrategy: "revert-and-force-push-with-lease", operation: JournalOperationType.Push })];
    const journal = fakeJournal(entries);
    const framework = new SafeUndoFramework(journal, noRegistry, {} as never, alwaysDeny);
    const plan = (await framework.buildUndoPlan("repo-1"))!;
    await expect(framework.executeUndoPlan(plan)).rejects.toThrow(/approval/i);
    // Denied before any mutation -- the entry must still read Completed.
    expect(entries[0].status).toBe(JournalEntryStatus.Completed);
  });

  it("no-ops silently when the journal entry no longer exists", async () => {
    const framework = new SafeUndoFramework(fakeJournal([]), noRegistry, {} as never, alwaysApprove);
    await expect(
      framework.executeUndoPlan({
        journalEntryId: "missing",
        operation: JournalOperationType.Commit,
        strategy: "reset-soft",
        requiresApproval: false,
        recordedAt: new Date(),
      }),
    ).resolves.toBeUndefined();
  });
});
