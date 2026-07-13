import { POLL_ERROR_BACKOFF_MS } from "./TelegramConstants";
import { describeError, logEvent } from "./TelegramLogger";
import type { ITelegramAdapter, ITelegramClient, ITelegramTransport } from "./interfaces";
import type { TelegramUpdate } from "./types";

export class TelegramLongPoller implements ITelegramTransport {
  private running = false;
  private offset?: number;
  private abortController?: AbortController;

  constructor(
    private readonly telegramClient: ITelegramClient,
    private readonly telegramAdapter: ITelegramAdapter,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    logEvent("info", "telegram.polling.started");

    while (this.running) {
      this.abortController = new AbortController();

      let updates: TelegramUpdate[];
      try {
        updates = await this.telegramClient.getUpdates(this.offset, undefined, this.abortController.signal);
      } catch (error) {
        if (!this.running) break;
        logEvent("error", "telegram.polling.fetch_failed", { error: describeError(error) });
        await this.delay(POLL_ERROR_BACKOFF_MS);
        continue;
      }

      if (updates.length > 0) {
        logEvent("info", "telegram.polling.batch_received", { count: updates.length, offset: this.offset ?? null });
      }

      for (const update of updates) {
        this.offset = update.updateId + 1;
        // One failing update must never stop the loop from processing the rest.
        await this.processUpdate(update);
      }
    }

    logEvent("info", "telegram.polling.stopped");
  }

  stop(): void {
    this.running = false;
    this.abortController?.abort();
  }

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    const context = {
      updateId: update.updateId,
      chatId: update.message?.chatId ?? null,
      userId: update.message?.userId ?? null,
    };

    logEvent("info", "telegram.update.processing", context);
    const startedAt = Date.now();

    try {
      await this.telegramAdapter.handleUpdate(update);
      logEvent("info", "telegram.update.processed", { ...context, durationMs: Date.now() - startedAt });
    } catch (error) {
      logEvent("error", "telegram.update.failed", { ...context, error: describeError(error) });
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
