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

// The five "runtime-*" variants are distinct from the bare "status"/"insights"
// query types above (which are repository-scoped) — collision would occur
// otherwise, since /runtime's "status" subcommand and repository /status are
// different things entirely. All five are produced by CommandParser from the
// single "/runtime [subcommand]" namespace command (Phase 8.10) and all five
// are answered from exactly one ApplicationService.getRuntimeReport() call —
// none of them carry their own parameters, since RuntimeReport is a single,
// already-complete snapshot with no per-query variation.
export type ApplicationQuery =
  | { type: "status" }
  | { type: "history"; limit?: number }
  | { type: "insights" }
  | { type: "session" }
  | { type: "runtime-report" }
  | { type: "runtime-status" }
  | { type: "runtime-diagnostics" }
  | { type: "runtime-monitoring" }
  | { type: "runtime-policy" };

export type ParsedCommand =
  | { kind: "task"; task: Task; repositoryId?: string }
  | { kind: "workflow"; workflowId: string; input: Record<string, unknown>; repositoryId?: string }
  | { kind: "query"; query: ApplicationQuery; repositoryId?: string };
