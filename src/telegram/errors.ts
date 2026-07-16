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

export class NoNotificationRecipientConfiguredError extends Error {
  constructor() {
    super(
      "Cannot deliver an attention notification: no allowed Telegram users are configured in config/telegram.yaml (security.allowed_users).",
    );
    this.name = "NoNotificationRecipientConfiguredError";
  }
}
