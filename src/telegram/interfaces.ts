import type { ExecutionResult } from "../controller/types";
import type { OutgoingMessage, ParsedCommand, TelegramUpdate } from "./types";

export interface ITelegramAdapter {
  handleUpdate(update: TelegramUpdate): Promise<void>;
}

export interface ITelegramClient {
  sendMessage(message: OutgoingMessage): Promise<void>;
  getUpdates(offset?: number, timeoutSeconds?: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
}

export interface ITelegramTransport {
  start(): Promise<void>;
  stop(): void;
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
