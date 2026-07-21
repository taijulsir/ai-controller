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

// Telegram's own BotCommand shape (setMyCommands/getMyCommands) -- command
// must match ^[a-z0-9_]{1,32}$ (no hyphens, no leading slash) and
// description must be 1-256 characters. See TelegramCommands.ts for the
// actual registered list and why a few real commands (create-pr, list-prs,
// auto-execute) are deliberately absent from it.
export interface BotCommand {
  command: string;
  description: string;
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
  // Phase E (Claude Session Management): part of the "session" command
  // family (/session, /session reset, /session stop), parsed by
  // CommandParser's own buildSessionQuery() -- the exact same shape as the
  // "task" family's own task-cancel variant above.
  | { type: "session-reset" }
  | { type: "session-stop" }
  | { type: "help" }
  | { type: "recommendations" }
  | { type: "branch" }
  | { type: "branches" }
  | { type: "task" }
  // Part of the "task" command family (/task, /task cancel, and future
  // /task history|logs|retry), parsed by CommandParser's own buildTaskQuery()
  // -- deliberately still a "query" kind, not a new ParsedCommand kind of its
  // own: it resolves through ApplicationService + ResponseFormatter exactly
  // like every other query, it just happens to trigger a targeted,
  // narrowly-scoped side effect (cancelling) while answering, the same way
  // recordAutonomousPlanCycle() is a write reachable through
  // IApplicationService despite that interface's other methods being reads.
  | { type: "task-cancel" }
  // Phase B (Undo): a bare, top-level command like /ship, not part of the
  // "task" family -- it has no subcommand today, so unlike /task cancel it
  // needs no special repo= handling of its own; /undo repo=x and
  // repo=x /undo already work via the shared position-0/1 REPO_TOKEN logic
  // every command already gets.
  | { type: "undo" }
  | { type: "runtime-report" }
  | { type: "runtime-status" }
  | { type: "runtime-diagnostics" }
  | { type: "runtime-monitoring" }
  | { type: "runtime-policy" };

export type ParsedCommand =
  | { kind: "task"; task: Task; repositoryId?: string }
  | { kind: "workflow"; workflowId: string; input: Record<string, unknown>; repositoryId?: string }
  | { kind: "query"; query: ApplicationQuery; repositoryId?: string }
  // Phase 12: manually triggers AutonomousExecutionOrchestrator.attemptExecution()
  // exactly once. Carries no task/workflow/query data of its own -- the
  // orchestrator reads its own input (the schedule), it never receives one
  // from this command.
  | { kind: "autonomous-execute" };
