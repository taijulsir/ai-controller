import type { ITelegramCallbackHandler } from "./interfaces";
import type { TelegramCallbackQuery } from "./types";

// TelegramLongPoller accepts exactly one ITelegramCallbackHandler -- this is
// the one seam that lets more than one kind of inline button coexist behind
// it. Dispatches every callback_query to each registered handler in turn;
// every existing handler (TelegramApprovalProvider.handleCallback) already
// self-filters by its own callback_data prefix and returns immediately on a
// non-match, so calling all of them unconditionally is safe and requires no
// change to any of them. Adding a future action (a new inline button prefix
// entirely, or a new action alongside Show/Diff/Undo) means adding one more
// handler here, never touching this class, TelegramLongPoller, or any
// existing handler.
export class TelegramCallbackRouter implements ITelegramCallbackHandler {
  private readonly handlers: readonly ITelegramCallbackHandler[];

  constructor(...handlers: ITelegramCallbackHandler[]) {
    this.handlers = handlers;
  }

  async handleCallback(callbackQuery: TelegramCallbackQuery): Promise<void> {
    for (const handler of this.handlers) {
      await handler.handleCallback(callbackQuery);
    }
  }
}
