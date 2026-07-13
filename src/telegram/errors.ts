export class CommandParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandParseError";
  }
}

export class TelegramApiError extends Error {
  constructor(status: number, body: string) {
    super(`Telegram API request failed (status ${status}): ${body}`);
    this.name = "TelegramApiError";
  }
}
