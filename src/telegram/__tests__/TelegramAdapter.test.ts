import { describe, expect, it } from "vitest";
import type { IApplicationService } from "../../application/interfaces";
import type { CommitDetail, CommitDiffStatResult, CommitSummary, GitHistoryResult } from "../../git/types";
import type { UndoOutcome } from "../../undo/types";
import { ResponseFormatter } from "../ResponseFormatter";
import { MAX_HISTORY_KEYBOARD_ITEMS } from "../TelegramConstants";
import { TelegramAdapter } from "../TelegramAdapter";
import type { ITelegramClient, ITelegramSecurity } from "../interfaces";
import type { OutgoingMessage, TelegramCallbackQuery, TelegramUpdate } from "../types";

function fakeTelegramClient(): ITelegramClient & { sent: OutgoingMessage[]; answered: { id: string; text?: string }[] } {
  const sent: OutgoingMessage[] = [];
  const answered: { id: string; text?: string }[] = [];
  return {
    sent,
    answered,
    sendMessage: async (message) => {
      sent.push(message);
    },
    sendDocument: async () => {},
    getUpdates: async () => [],
    answerCallbackQuery: async (id, text) => {
      answered.push({ id, text });
    },
    setMyCommands: async () => {},
  };
}

function fakeSecurity(authorized = true): ITelegramSecurity {
  return { isAuthorized: () => authorized, isAdmin: () => false };
}

function commitDetail(): CommitDetail {
  return {
    sha: "6739c2e44833dbed637f3d9702fb03c378a7f2f2",
    shortSha: "6739c2e",
    authorName: "Taijul",
    authorEmail: "taijul@example.com",
    authorDate: new Date(),
    parents: [],
    subject: "feat: redesign orchestration",
    body: "feat: redesign orchestration",
    isHead: true,
    currentBranch: "main",
    files: [],
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
  };
}

// IApplicationService has a very large surface (every ApplicationQuery type
// this bot answers) -- unlike every other fake in this codebase (which
// implements a small interface in full), only the one or two methods each
// test actually exercises are provided here; handleCallback() never touches
// anything else, and a bug that made it do so would fail loudly (a native
// "not a function" TypeError), not silently.
function fakeApplicationService(overrides: Partial<IApplicationService>): IApplicationService {
  return overrides as IApplicationService;
}

function buildAdapter(applicationService: IApplicationService, telegramClient: ITelegramClient, telegramSecurity: ITelegramSecurity): TelegramAdapter {
  const unused = undefined as never;
  return new TelegramAdapter(unused, applicationService, telegramSecurity, telegramClient, unused, unused, undefined, new ResponseFormatter());
}

const baseQuery = (data: string): TelegramCallbackQuery => ({ id: "cb-1", data, chatId: 42, userId: 7 });

// Regression coverage for the Git History & Inspection System's inline
// Show/Diff/Undo buttons -- TelegramAdapter.handleCallback() must reach the
// exact same ApplicationService calls a manually-typed "/show <hash>",
// "/diff <hash>", "/undo <hash>" would, and must self-filter (ignore)
// anything it doesn't own, the same contract every ITelegramCallbackHandler
// in this codebase already follows (see TelegramCallbackRouter's own tests).
describe("TelegramAdapter.handleCallback", () => {
  it("ignores callback data with an unrelated prefix", async () => {
    const client = fakeTelegramClient();
    const adapter = buildAdapter(fakeApplicationService({}), client, fakeSecurity());

    await adapter.handleCallback(baseQuery("approval:approve:telegram:1:2"));

    expect(client.sent).toHaveLength(0);
    expect(client.answered).toHaveLength(0);
  });

  it("refuses an unauthorized user without calling ApplicationService", async () => {
    const client = fakeTelegramClient();
    let called = false;
    const applicationService = fakeApplicationService({
      getCommitDetail: async () => {
        called = true;
        return commitDetail();
      },
    });
    const adapter = buildAdapter(applicationService, client, fakeSecurity(false));

    await adapter.handleCallback(baseQuery("history:show:repo-1:6739c2e"));

    expect(called).toBe(false);
    expect(client.answered).toHaveLength(1);
  });

  it("dispatches 'show' to getCommitDetail with the repository id and hash from callback_data", async () => {
    const client = fakeTelegramClient();
    let receivedArgs: unknown[] = [];
    const applicationService = fakeApplicationService({
      getCommitDetail: async (...args: unknown[]) => {
        receivedArgs = args;
        return commitDetail();
      },
    });
    const adapter = buildAdapter(applicationService, client, fakeSecurity());

    await adapter.handleCallback(baseQuery("history:show:test-ai-controller:6739c2e"));

    expect(receivedArgs).toEqual(["test-ai-controller", "6739c2e"]);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0].text).toContain("feat: redesign orchestration");
    expect(client.answered).toHaveLength(1);
  });

  it("dispatches 'diff' to getCommitDiffStat", async () => {
    const client = fakeTelegramClient();
    let receivedArgs: unknown[] = [];
    const diffResult: CommitDiffStatResult = { sha: "aaa", shortSha: "6739c2e", files: [], filesChanged: 0, insertions: 0, deletions: 0 };
    const applicationService = fakeApplicationService({
      getCommitDiffStat: async (...args: unknown[]) => {
        receivedArgs = args;
        return diffResult;
      },
    });
    const adapter = buildAdapter(applicationService, client, fakeSecurity());

    await adapter.handleCallback(baseQuery("history:diff:repo-1:6739c2e"));

    expect(receivedArgs).toEqual(["repo-1", "6739c2e"]);
    expect(client.sent).toHaveLength(1);
  });

  it("dispatches 'undo' to undoLastExecution with the short sha as target", async () => {
    const client = fakeTelegramClient();
    let receivedArgs: unknown[] = [];
    const outcome: UndoOutcome = { kind: "target-mismatch-git", expectedHash: "deadbeef", operation: "commit" as never, givenTarget: "6739c2e" };
    const applicationService = fakeApplicationService({
      undoLastExecution: async (...args: unknown[]) => {
        receivedArgs = args;
        return outcome;
      },
    });
    const adapter = buildAdapter(applicationService, client, fakeSecurity());

    await adapter.handleCallback(baseQuery("history:undo:repo-1:6739c2e"));

    expect(receivedArgs).toEqual(["repo-1", "6739c2e"]);
    expect(client.sent).toHaveLength(1);
  });
});

// Regression coverage for the inline-keyboard cap: a /history reply larger
// than MAX_HISTORY_KEYBOARD_ITEMS must still attach a keyboard (bounded),
// never one row per commit unconditionally.
describe("TelegramAdapter.handleUpdate: /history keyboard cap", () => {
  function commit(i: number): CommitSummary {
    return { sha: `sha-${i}`, shortSha: `sha${i}`, message: `commit ${i}`, author: "Taijul", date: new Date() };
  }

  function historyUpdate(text: string): TelegramUpdate {
    return { updateId: 1, message: { chatId: 42, userId: 7, text } };
  }

  it("caps the inline keyboard at MAX_HISTORY_KEYBOARD_ITEMS while the text still lists every commit", async () => {
    const client = fakeTelegramClient();
    const commitCount = MAX_HISTORY_KEYBOARD_ITEMS + 10;
    const result: GitHistoryResult = {
      repositoryId: "repo-1",
      commits: Array.from({ length: commitCount }, (_, i) => commit(i)),
      currentBranch: "main",
      headSha: "sha-0",
      detachedHead: false,
    };
    const applicationService = fakeApplicationService({ getCommitHistory: async () => result });
    const adapter = buildAdapter(applicationService, client, fakeSecurity());

    await adapter.handleUpdate(historyUpdate(`/history ${commitCount}`));

    expect(client.sent).toHaveLength(1);
    expect(client.sent[0].inlineKeyboard).toHaveLength(MAX_HISTORY_KEYBOARD_ITEMS);
    for (let i = 0; i < commitCount; i++) {
      expect(client.sent[0].text).toContain(`sha${i}`);
    }
  });

  it("attaches one row per commit when the count is within MAX_HISTORY_KEYBOARD_ITEMS", async () => {
    const client = fakeTelegramClient();
    const result: GitHistoryResult = {
      repositoryId: "repo-1",
      commits: Array.from({ length: 3 }, (_, i) => commit(i)),
      currentBranch: "main",
      headSha: "sha-0",
      detachedHead: false,
    };
    const applicationService = fakeApplicationService({ getCommitHistory: async () => result });
    const adapter = buildAdapter(applicationService, client, fakeSecurity());

    await adapter.handleUpdate(historyUpdate("/history 3"));

    expect(client.sent[0].inlineKeyboard).toHaveLength(3);
  });
});
