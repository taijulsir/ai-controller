import type { Task } from "../planner/types";

export interface TelegramCallbackQuery {
  id: string;
  data: string;
  chatId: number;
  userId: number;
}

export interface TelegramUpdate {
  updateId: number;
  message?: {
    chatId: number;
    userId: number;
    text: string;
  };
  callbackQuery?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callbackData: string;
}

export interface OutgoingMessage {
  chatId: number;
  text: string;
  inlineKeyboard?: InlineKeyboardButton[][];
}

export type ApplicationQuery =
  | { type: "status" }
  | { type: "history"; limit?: number }
  | { type: "insights" }
  | { type: "session" };

export type ParsedCommand =
  | { kind: "task"; task: Task; repositoryId?: string }
  | { kind: "workflow"; workflowId: string; input: Record<string, unknown>; repositoryId?: string }
  | { kind: "query"; query: ApplicationQuery; repositoryId?: string };
