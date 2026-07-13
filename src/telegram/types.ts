import type { Task } from "../planner/types";

export interface TelegramUpdate {
  updateId: number;
  message?: {
    chatId: number;
    userId: number;
    text: string;
  };
}

export interface OutgoingMessage {
  chatId: number;
  text: string;
}

export interface ParsedCommand {
  task: Task;
  repositoryId?: string;
}
