import type { ExecutionResult } from "../controller/types";
import type { OutgoingMessage, ParsedCommand, TelegramCallbackQuery, TelegramUpdate } from "./types";

export interface ITelegramAdapter {
  handleUpdate(update: TelegramUpdate): Promise<void>;
}

export interface ITelegramClient {
  sendMessage(message: OutgoingMessage): Promise<void>;
  getUpdates(offset?: number, timeoutSeconds?: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
}

export interface ITelegramTransport {
  start(): Promise<void>;
  stop(): void;
}

export interface ITelegramCallbackHandler {
  handleCallback(callbackQuery: TelegramCallbackQuery): Promise<void>;
}

export interface ICommandParser {
  parse(text: string): ParsedCommand;
}

export interface IResponseFormatter {
  format(result: ExecutionResult): string;
}

export interface ITelegramSecurity {
  isAuthorized(userId: number): boolean;
}
