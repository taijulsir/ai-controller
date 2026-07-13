import type { IConfigService } from "../config/interfaces";
import { buildTelegramApiUrl, LONG_POLL_TIMEOUT_SECONDS } from "./TelegramConstants";
import { TelegramApiError } from "./errors";
import type { ITelegramClient } from "./interfaces";
import type { OutgoingMessage, TelegramUpdate } from "./types";

interface RawTelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: { id: number };
    text?: string;
  };
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export class TelegramApiClient implements ITelegramClient {
  constructor(private readonly configService: IConfigService) {}

  async sendMessage(message: OutgoingMessage): Promise<void> {
    const { bot } = this.configService.getTelegramConfig();
    const url = buildTelegramApiUrl(bot.token, "sendMessage");

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: message.chatId, text: message.text }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new TelegramApiError(response.status, body);
    }
  }

  async getUpdates(
    offset?: number,
    timeoutSeconds: number = LONG_POLL_TIMEOUT_SECONDS,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    const { bot } = this.configService.getTelegramConfig();
    const url = buildTelegramApiUrl(bot.token, "getUpdates");

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offset, timeout: timeoutSeconds, allowed_updates: ["message"] }),
      signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new TelegramApiError(response.status, body);
    }

    const payload = (await response.json()) as TelegramApiResponse<RawTelegramUpdate[]>;
    if (!payload.ok || !payload.result) {
      throw new TelegramApiError(response.status, payload.description ?? "getUpdates returned ok:false");
    }

    return payload.result.map((raw) => this.toDomainUpdate(raw));
  }

  private toDomainUpdate(raw: RawTelegramUpdate): TelegramUpdate {
    const { message } = raw;
    if (!message || message.from === undefined || message.text === undefined) {
      return { updateId: raw.update_id };
    }

    return {
      updateId: raw.update_id,
      message: { chatId: message.chat.id, userId: message.from.id, text: message.text },
    };
  }
}
