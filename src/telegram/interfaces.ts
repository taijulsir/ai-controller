import type { ExecutionResult } from "../controller/types";
import type { OutgoingMessage, ParsedCommand, TelegramUpdate } from "./types";

export interface ITelegramAdapter {
  handleUpdate(update: TelegramUpdate): Promise<void>;
}

export interface ITelegramClient {
  sendMessage(message: OutgoingMessage): Promise<void>;
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
