import type { IConfigService } from "../config/interfaces";
import { buildTelegramApiUrl, LONG_POLL_TIMEOUT_SECONDS, TELEGRAM_MAX_MESSAGE_LENGTH } from "./TelegramConstants";
import { TelegramApiError } from "./errors";
import type { ITelegramClient } from "./interfaces";
import { splitMessageText } from "./TelegramMessageSplitter";
import type { InlineKeyboardButton, OutgoingMessage, TelegramUpdate } from "./types";

interface RawTelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    from?: { id: number };
    message?: { chat: { id: number } };
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
    const chunks = splitMessageText(message.text, TELEGRAM_MAX_MESSAGE_LENGTH);

    for (let index = 0; index < chunks.length; index++) {
      const isLastChunk = index === chunks.length - 1;
      // Only the final chunk carries the inline keyboard, so approval
      // buttons never appear more than once for a single logical reply.
      await this.sendSingleMessage({
        chatId: message.chatId,
        text: chunks[index],
        inlineKeyboard: isLastChunk ? message.inlineKeyboard : undefined,
      });
    }
  }

  private async sendSingleMessage(message: OutgoingMessage): Promise<void> {
    const { bot } = this.configService.getTelegramConfig();
    const url = buildTelegramApiUrl(bot.token, "sendMessage");

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: message.chatId,
        text: message.text,
        ...(message.inlineKeyboard ? { reply_markup: this.toReplyMarkup(message.inlineKeyboard) } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new TelegramApiError(response.status, body);
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    const { bot } = this.configService.getTelegramConfig();
    const url = buildTelegramApiUrl(bot.token, "answerCallbackQuery");

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
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
      body: JSON.stringify({
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ["message", "callback_query"],
      }),
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

  private toReplyMarkup(inlineKeyboard: InlineKeyboardButton[][]): unknown {
    return {
      inline_keyboard: inlineKeyboard.map((row) =>
        row.map((button) => ({ text: button.text, callback_data: button.callbackData })),
      ),
    };
  }

  private toDomainUpdate(raw: RawTelegramUpdate): TelegramUpdate {
    const { callback_query: callbackQuery, message } = raw;

    if (callbackQuery && callbackQuery.data !== undefined && callbackQuery.from && callbackQuery.message) {
      return {
        updateId: raw.update_id,
        callbackQuery: {
          id: callbackQuery.id,
          data: callbackQuery.data,
          chatId: callbackQuery.message.chat.id,
          userId: callbackQuery.from.id,
        },
      };
    }

    if (!message || message.from === undefined || message.text === undefined) {
      return { updateId: raw.update_id };
    }

    return {
      updateId: raw.update_id,
      message: { chatId: message.chat.id, userId: message.from.id, text: message.text },
    };
  }
}
