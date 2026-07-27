import type { Task, TaskType } from "../planner/types";

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

// Artifact Management: content is always fully buffered before this is
// built -- an artifact's stored size is bounded by ordinary source-file/diff/
// log sizes, never large enough to justify streaming the upload itself.
export interface OutgoingDocument {
  chatId: number;
  filename: string;
  content: Buffer;
  caption?: string;
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
  // Renamed from "history": reachable only via "/task history" now that
  // "/history" means the Git History & Inspection System's own commit log
  // (the "git-history" variant below) -- parsed by CommandParser's own
  // buildTaskQuery(), the same "task" subcommand family "task-cancel" is
  // part of.
  | { type: "task-history"; limit?: number }
  | { type: "insights" }
  // Repository Failure Policy redesign: /failures -- a bare, top-level
  // query, same shape as "insights"/"status" (no arguments of its own).
  | { type: "failures" }
  // /clear-failures [taskType] -- taskType undefined means "clear every task
  // type for this repository," parsed by CommandParser's own dedicated
  // block (same "argument shape decides the query's own parameters" pattern
  // "discard-change"/"discard-all" already use for themselves). Unlike
  // discard-all/artifact-delete-all, there is no `confirmed` field here --
  // clearing a derived failure counter destroys nothing irreversible (the
  // underlying ProjectMemoryEvent history is untouched and this already
  // self-heals on the next success), so it acts immediately, the same way
  // /session reset and /task cancel already do without a confirm gate.
  | { type: "clear-failures"; taskType?: TaskType }
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
  // Git History & Inspection System: target is undefined for a bare
  // "/undo" (preview), the literal "confirm", or a commit hash/prefix --
  // see ApplicationService.undoLastExecution()'s own doc comment.
  | { type: "undo"; target?: string }
  // Git History & Inspection System: /history [count | branch:<name> |
  // author:<name> | search:<text>] -- exactly one of limit/branch/author/
  // search is ever set per call (CommandParser.buildGitHistoryQuery()
  // recognizes one filter per invocation, matching every example the
  // feature was specified with), never combined.
  | { type: "git-history"; limit?: number; branch?: string; author?: string; search?: string }
  | { type: "git-show"; hash: string }
  | { type: "git-diff"; hash: string }
  // Git Orchestration redesign: bare, top-level commands, same shape as
  // "undo" above -- none takes a subcommand or repo=-adjacent argument of
  // its own.
  | { type: "health" }
  | { type: "recover" }
  | { type: "resume" }
  | { type: "abort" }
  // Working Tree Management: /changes, /showchanges <index>, /discard
  // <index> [confirm], /discard all [confirm] -- parsed by CommandParser's
  // own dedicated blocks (same "argument shape decides kind" reasoning
  // "branch"/"discard" already document for themselves). "confirmed" is
  // false for a bare "/discard <index>"/"/discard all" -- CommandParser
  // never discards anything itself either way, it only ever reports what the
  // user typed; ApplicationService decides what an unconfirmed request does
  // (report a plan and refuse, never discard), the same contract
  // "artifact-delete-all"'s own confirmed field already documents.
  | { type: "working-tree-changes" }
  | { type: "working-tree-change-diff"; index: number }
  | { type: "discard-change"; index: number; confirmed: boolean }
  | { type: "discard-all"; confirmed: boolean }
  | { type: "runtime-report" }
  | { type: "runtime-status" }
  | { type: "runtime-diagnostics" }
  | { type: "runtime-monitoring" }
  | { type: "runtime-policy" }
  // Artifact Management: the "artifact" command family (/artifact,
  // /artifact get|search|delete|delete-all|rebuild-index), parsed by
  // CommandParser's own buildArtifactQuery() -- same closed-subcommand-
  // vocabulary shape as the "task"/"session" families above. "artifact-get"
  // is handled specially by TelegramAdapter (it sends the artifact's
  // content as a document, not a formatted text reply) rather than through
  // the generic handleQuery() switch every other query type uses;
  // "artifact-delete"/"artifact-delete-all"/"artifact-rebuild-index" are
  // gated behind TelegramSecurity.isAdmin the same way, at the transport
  // layer, not here.
  | { type: "artifact-list" }
  | { type: "artifact-get"; id: string }
  | { type: "artifact-search"; query: string }
  // Always at least one id -- "/artifact delete <id>" and
  // "/artifact delete <id1> <id2> ..." are the same query shape, single
  // deletion is just the one-id case of batch deletion, never a second,
  // near-duplicate query variant.
  | { type: "artifact-delete"; ids: string[] }
  // confirmed is false for a bare "/artifact delete-all" -- CommandParser
  // never performs the deletion itself either way, it only ever reports
  // what the user typed; ApplicationService decides what an unconfirmed
  // request does (report a count and refuse, never delete).
  | { type: "artifact-delete-all"; confirmed: boolean }
  | { type: "artifact-rebuild-index" };

export type ParsedCommand =
  | { kind: "task"; task: Task; repositoryId?: string }
  | { kind: "workflow"; workflowId: string; input: Record<string, unknown>; repositoryId?: string }
  | { kind: "query"; query: ApplicationQuery; repositoryId?: string }
  // Phase 12: manually triggers AutonomousExecutionOrchestrator.attemptExecution()
  // exactly once. Carries no task/workflow/query data of its own -- the
  // orchestrator reads its own input (the schedule), it never receives one
  // from this command.
  | { kind: "autonomous-execute" };
