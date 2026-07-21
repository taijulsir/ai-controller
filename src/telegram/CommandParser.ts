import type { Task } from "../planner/types";
import { CommandParseError } from "./errors";
import type { ICommandParser } from "./interfaces";
import type { ApplicationQuery, ParsedCommand } from "./types";

const QUERY_COMMANDS: ReadonlySet<string> = new Set([
  "status",
  "history",
  "insights",
  "runtime",
  "help",
  "recommendations",
  "branches",
  "undo",
]);

type TaskBuilder = (args: string) => Task;

export class CommandParser implements ICommandParser {
  // A flat lookup table today; structured so a future CommandRegistry can
  // supply or extend this mapping without touching the tokenizing logic below.
  private readonly commandHandlers: Record<string, TaskBuilder> = {
    analyze: (args) => ({
      type: "analyze-repository",
      input: args ? { focus: args } : undefined,
    }),
    review: (args) => ({
      type: "review-code",
      input: args ? { focus: args } : undefined,
    }),
    explain: (args) => {
      if (!args) throw new CommandParseError('"explain" requires a target, e.g. "explain src/foo.ts".');
      return { type: "explain-code", input: { target: args } };
    },
    implement: (args) => {
      if (!args) throw new CommandParseError('"implement" requires a description.');
      return { type: "implement-feature", input: { description: args } };
    },
    fix: (args) => {
      if (!args) throw new CommandParseError('"fix" requires a description.');
      return { type: "fix-bug", input: { description: args } };
    },
    commit: (args) => {
      if (!args) throw new CommandParseError('"commit" requires a message.');
      return { type: "create-commit", input: { message: args } };
    },
    push: () => ({ type: "push-changes" }),
    "create-pr": (args) => {
      if (!args) throw new CommandParseError('"create-pr" requires a title, e.g. "create-pr Add login flow".');
      return { type: "create-pull-request", input: { title: args } };
    },
    "list-prs": () => ({ type: "list-pull-requests" }),
    fetch: () => ({ type: "fetch" }),
    sync: () => ({ type: "sync" }),
    // Deliberately no implicit default branch (e.g. the repository's own
    // default branch) -- a merge is a potentially significant operation, so
    // it must always be named explicitly. A bare "/merge" returns a usage
    // message instead of performing any merge.
    merge: (args) => {
      if (!args) throw new CommandParseError('"merge" requires a branch name, e.g. "merge main".');
      return { type: "merge", input: { branch: args } };
    },
  };

  parse(text: string): ParsedCommand {
    const tokens = text.trim().split(/\s+/).filter((token) => token.length > 0);

    // repo=<id> is recognized only in two fixed positions: immediately
    // before the command name (token 0), or immediately after it (the token
    // right after the command name). This parser never looks past position
    // two for one -- a repo=<id>-shaped token appearing later is left
    // completely alone, so it stays as ordinary argument/description text
    // (e.g. "/implement Add support for repo=test query parameter" must
    // reach Claude unchanged).
    const REPO_TOKEN = /^repo=(\S+)$/;
    let repositoryId: string | undefined;
    let commandName: string | undefined;
    let remainingTokens: string[];

    const leadingRepoMatch = tokens[0]?.match(REPO_TOKEN);
    if (leadingRepoMatch) {
      repositoryId = leadingRepoMatch[1];
      commandName = tokens[1];
      remainingTokens = tokens.slice(2);
    } else {
      commandName = tokens[0];
      const trailingRepoMatch = tokens[1]?.match(REPO_TOKEN);
      if (trailingRepoMatch) {
        repositoryId = trailingRepoMatch[1];
        remainingTokens = tokens.slice(2);
      } else {
        remainingTokens = tokens.slice(1);
      }
    }

    const args = remainingTokens.join(" ");
    // Stripped here, from whichever token resolved to the command name,
    // rather than from the start of the whole message: when repo=<id>
    // leads, the command name is tokens[1], which still carries its own "/"
    // (the message itself never started with one). Doing it at this single
    // point, after the command token is already chosen, handles both
    // "/status repo=x" and "repo=x /status" identically without either
    // branch above needing to know about slashes at all.
    const normalizedCommand = commandName?.replace(/^\//, "").toLowerCase();

    if (normalizedCommand === "ship") {
      if (!args) {
        throw new CommandParseError('"ship" requires a message, e.g. "ship Add dark mode toggle".');
      }
      return { kind: "workflow", workflowId: "ship", input: { message: args }, repositoryId };
    }

    // Phase 12: no repositoryId/args of its own -- AutonomousExecutionOrchestrator
    // decides which repository (if any) to attempt from the schedule itself,
    // the same way it already does for every non-Telegram caller.
    if (normalizedCommand === "auto-execute") {
      return { kind: "autonomous-execute" };
    }

    // "branch" is neither a pure query nor a pure task command: with no
    // args it reports current branch info (query, reusing the same
    // getRepositoryStatus() /status already calls); with args it switches
    // (or, with a "create" prefix, creates and switches) — both task-kind,
    // both bypass-eligible in ExecutionPipeline exactly like commit/push/
    // create-pr. Handled once, here, rather than forcing QUERY_COMMANDS/
    // commandHandlers to encode a command whose kind depends on its own
    // arguments.
    if (normalizedCommand === "branch") {
      if (!args) {
        return { kind: "query", query: { type: "branch" }, repositoryId };
      }
      const argTokens = args.split(/\s+/).filter((token) => token.length > 0);
      if (argTokens[0]?.toLowerCase() === "create" && argTokens.length > 1) {
        return {
          kind: "task",
          task: { type: "create-branch", input: { branch: argTokens.slice(1).join(" ") } },
          repositoryId,
        };
      }
      return { kind: "task", task: { type: "switch-branch", input: { branch: args } }, repositoryId };
    }

    // "task" is a command family (bare /task, /task cancel, and future
    // /task history|logs|retry) -- handled here, before the generic
    // QUERY_COMMANDS dispatch, the same way "branch" is handled above.
    // Unlike "branch", every member of this family stays "query" kind (none
    // of them build a Task domain object or go through ExecutionPipeline),
    // so this never needs to branch on kind the way "branch" does -- it only
    // needs its own repo= handling, which the shared REPO_TOKEN logic above
    // does not fully cover: that logic only recognizes repo=<id> at position
    // 0 (leading) or position 1 (immediately trailing the command name), a
    // deliberate limit so a repo=-shaped word buried inside a free-text
    // description (e.g. "/implement ... repo=parser") is never misread as an
    // override. "task"'s own subcommand vocabulary is closed and never free
    // text, so — for this family only — it is also safe to recognize a
    // trailing repo=<id> as the message's own last token, covering
    // "/task cancel repo=my-repo" (repo= after the subcommand, a position
    // the shared logic intentionally does not scan) without loosening that
    // rule for any other command.
    if (normalizedCommand === "task") {
      const taskArgTokens = args.split(/\s+/).filter((token) => token.length > 0);
      const trailingTaskRepoMatch = taskArgTokens[taskArgTokens.length - 1]?.match(REPO_TOKEN);
      if (trailingTaskRepoMatch && repositoryId === undefined) {
        repositoryId = trailingTaskRepoMatch[1];
        taskArgTokens.pop();
      }
      return { kind: "query", query: this.buildTaskQuery(taskArgTokens.join(" ").toLowerCase()), repositoryId };
    }

    // "session" is a command family (bare /session, /session reset,
    // /session stop) -- handled here the same way "task" is above, including
    // the identical reasoning for its own trailing repo= scan: "session"'s
    // own subcommand vocabulary is closed and never free text, so
    // recognizing repo=<id> as the message's own last token is safe here
    // too, covering "/session reset repo=my-repo" the same way
    // "/task cancel repo=my-repo" is already covered.
    if (normalizedCommand === "session") {
      const sessionArgTokens = args.split(/\s+/).filter((token) => token.length > 0);
      const trailingSessionRepoMatch = sessionArgTokens[sessionArgTokens.length - 1]?.match(REPO_TOKEN);
      if (trailingSessionRepoMatch && repositoryId === undefined) {
        repositoryId = trailingSessionRepoMatch[1];
        sessionArgTokens.pop();
      }
      return { kind: "query", query: this.buildSessionQuery(sessionArgTokens.join(" ").toLowerCase()), repositoryId };
    }

    if (normalizedCommand && QUERY_COMMANDS.has(normalizedCommand)) {
      return { kind: "query", query: this.buildQuery(normalizedCommand, args), repositoryId };
    }

    const handler = normalizedCommand ? this.commandHandlers[normalizedCommand] : undefined;
    if (!handler) {
      throw this.unrecognized("command", commandName ?? "");
    }

    return { kind: "task", task: handler(args), repositoryId };
  }

  private buildQuery(command: string, args: string): ApplicationQuery {
    if (command === "history") {
      if (!args) {
        return { type: "history" };
      }
      const limit = Number.parseInt(args, 10);
      if (Number.isNaN(limit) || limit <= 0) {
        throw new CommandParseError('"history" takes an optional positive number, e.g. "history 10".');
      }
      return { type: "history", limit };
    }
    if (command === "runtime") {
      return this.buildRuntimeQuery(args);
    }
    return { type: command as "status" | "insights" | "help" | "recommendations" | "branches" | "undo" };
  }

  // A bare "/task" (subcommand === "") behaves like the existing plain
  // "task" query; "cancel" is the one other member of the family
  // implemented today. An unrecognized subcommand falls through to the same
  // CommandParseError every other unrecognized command already throws.
  private buildTaskQuery(subcommand: string): ApplicationQuery {
    switch (subcommand) {
      case "":
        return { type: "task" };
      case "cancel":
        return { type: "task-cancel" };
      default:
        throw this.unrecognized("task command", subcommand);
    }
  }

  // A bare "/session" (subcommand === "") behaves like the existing plain
  // "session" query; "reset" and "stop" are the two new members of the
  // family. An unrecognized subcommand falls through to the same
  // CommandParseError every other unrecognized command already throws.
  private buildSessionQuery(subcommand: string): ApplicationQuery {
    switch (subcommand) {
      case "":
        return { type: "session" };
      case "reset":
        return { type: "session-reset" };
      case "stop":
        return { type: "session-stop" };
      default:
        throw this.unrecognized("session command", subcommand);
    }
  }

  // A bare "/runtime" (args === "") is normalized to "report" so it behaves
  // exactly the same as "/runtime report" — both resolve to the identical
  // ApplicationQuery variant, per Phase 8.10's requirement. An unrecognized
  // subcommand (e.g. "/runtime foo") falls through to the same
  // CommandParseError every other unrecognized command already throws,
  // caught by TelegramAdapter and sent back to the user as a plain reply —
  // the existing unknown-command behavior, not a separate mechanism.
  private buildRuntimeQuery(args: string): ApplicationQuery {
    const subcommand = args.trim().toLowerCase() || "report";

    switch (subcommand) {
      case "report":
        return { type: "runtime-report" };
      case "status":
        return { type: "runtime-status" };
      case "diagnostics":
        return { type: "runtime-diagnostics" };
      case "monitoring":
        return { type: "runtime-monitoring" };
      case "policy":
        return { type: "runtime-policy" };
      default:
        throw this.unrecognized("runtime command", subcommand);
    }
  }

  // The one place every "I don't recognize X" message is built -- previously
  // duplicated (with a slightly different phrase each time) at all three
  // call sites above. Standardized wording plus a consistent pointer to
  // /help, since none of the three previously told the user where to look.
  private unrecognized(label: string, name: string): CommandParseError {
    return new CommandParseError(`Sorry, I don't recognize the ${label} "${name}". Send /help to see available commands.`);
  }
}
