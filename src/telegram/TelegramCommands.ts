import type { BotCommand } from "./types";

// The list registered with Telegram via ITelegramClient.setMyCommands() so
// typing "/" in a chat shows the bot's own command suggestions. Every
// top-level command CommandParser actually recognizes, except three:
// "create-pr", "list-prs", and "auto-execute" are real, working commands
// (unchanged by this list) but cannot appear here -- Telegram's BotCommand
// "command" field is restricted to ^[a-z0-9_]{1,32}$ and rejects the entire
// setMyCommands call if any entry contains a hyphen. Renaming them to fit
// that pattern would be a real command-behavior change, not a registration
// fix, so they're simply omitted from the suggestion list; they still work
// exactly as before when typed out in full. Subcommands (e.g. "task cancel",
// "session reset") are not separate entries -- Telegram only suggests the
// top-level command name itself, never arguments.
export const BOT_COMMANDS: readonly BotCommand[] = [
  { command: "help", description: "List available commands" },
  { command: "status", description: "Repository status snapshot" },
  { command: "insights", description: "Derived repository insights" },
  { command: "recommendations", description: "Current ranked recommendations" },
  { command: "session", description: "Claude session status" },
  // Git History & Inspection System: "history" is no longer task/workflow
  // execution history -- see "/task history" (a subcommand, not listed
  // separately here) for that.
  { command: "task", description: "Currently running/awaiting-approval task" },
  // Git History & Inspection System: a bare "/undo" now previews recent
  // commits instead of acting -- reply with "/undo <hash>" or "/undo
  // confirm" to actually undo.
  { command: "undo", description: "Preview or confirm reversing the last change" },
  { command: "runtime", description: "Background runtime operations report" },
  { command: "artifact", description: "List, get, or search generated artifacts" },
  { command: "analyze", description: "Ask Claude to analyze the repository" },
  { command: "explain", description: "Ask Claude to explain part of the codebase" },
  { command: "implement", description: "Ask Claude to implement a feature" },
  { command: "fix", description: "Ask Claude to fix a bug" },
  { command: "review", description: "Ask Claude to review the repository" },
  { command: "branch", description: "Show, switch, or create a branch" },
  { command: "branches", description: "List local branches" },
  { command: "commit", description: "Stage and commit all changes" },
  { command: "push", description: "Push the current branch" },
  { command: "fetch", description: "Fetch from the remote" },
  // Git Orchestration redesign: now reconciles divergence automatically
  // (rebase/merge/ask, per configuration) instead of only fast-forwarding.
  { command: "sync", description: "Sync the current branch with its upstream" },
  { command: "merge", description: "Merge a branch into the current one" },
  { command: "rebase", description: "Rebase the current branch onto another" },
  { command: "discard", description: "Discard all uncommitted changes" },
  { command: "recover", description: "Recover from an interrupted git state" },
  { command: "health", description: "Repository health report" },
  { command: "resume", description: "Resume an in-progress merge or rebase" },
  { command: "abort", description: "Abort the in-progress merge or rebase" },
  { command: "ship", description: "Commit, push, and open a pull request" },
  // Git History & Inspection System: commit log, single-commit detail, and
  // per-file diff stats -- reachable from Telegram with no SSH access.
  { command: "history", description: "Browse, filter, or search commit history" },
  { command: "show", description: "Inspect a single commit" },
  { command: "diff", description: "Structured per-file diff summary for a commit" },
];
