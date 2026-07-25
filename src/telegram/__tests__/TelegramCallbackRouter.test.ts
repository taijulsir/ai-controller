import { describe, expect, it } from "vitest";
import type { ITelegramCallbackHandler } from "../interfaces";
import { TelegramCallbackRouter } from "../TelegramCallbackRouter";
import type { TelegramCallbackQuery } from "../types";

function fakeHandler(): ITelegramCallbackHandler & { received: TelegramCallbackQuery[] } {
  const received: TelegramCallbackQuery[] = [];
  return {
    received,
    async handleCallback(callbackQuery) {
      received.push(callbackQuery);
    },
  };
}

const query: TelegramCallbackQuery = { id: "cb-1", data: "history:show:repo-1:6739c2e", chatId: 1, userId: 2 };

// Regression coverage for the extensibility contract Git History &
// Inspection System's inline buttons rely on: TelegramLongPoller accepts
// exactly one ITelegramCallbackHandler, so a second kind of inline button
// (TelegramAdapter's Show/Diff/Undo, alongside TelegramApprovalProvider's
// existing Approve/Reject) can only coexist if something dispatches to both.
describe("TelegramCallbackRouter", () => {
  it("calls every registered handler for a single callback query", async () => {
    const first = fakeHandler();
    const second = fakeHandler();
    const router = new TelegramCallbackRouter(first, second);

    await router.handleCallback(query);

    expect(first.received).toEqual([query]);
    expect(second.received).toEqual([query]);
  });

  it("works with zero handlers registered", async () => {
    const router = new TelegramCallbackRouter();
    await expect(router.handleCallback(query)).resolves.toBeUndefined();
  });

  it("still calls the remaining handlers even though an earlier one doesn't recognize the callback (self-filtering, not routing, is each handler's own job)", async () => {
    const nonMatching: ITelegramCallbackHandler = {
      async handleCallback() {
        // Mirrors every real handler's own "no match, return immediately" guard.
      },
    };
    const matching = fakeHandler();
    const router = new TelegramCallbackRouter(nonMatching, matching);

    await router.handleCallback(query);

    expect(matching.received).toEqual([query]);
  });
});
