import type { IConfigService } from "../config/interfaces";
import { TelegramApiError } from "./errors";
import type { ITelegramClient } from "./interfaces";
import type { OutgoingMessage } from "./types";

export class TelegramApiClient implements ITelegramClient {
  constructor(private readonly configService: IConfigService) {}

  async sendMessage(message: OutgoingMessage): Promise<void> {
    const { bot } = this.configService.getTelegramConfig();
    const url = `https://api.telegram.org/bot${bot.token}/sendMessage`;

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
}
