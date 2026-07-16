import type { Task } from "../planner/types";
import { CommandParseError } from "./errors";
import type { ICommandParser } from "./interfaces";
import type { ApplicationQuery, ParsedCommand } from "./types";

const QUERY_COMMANDS: ReadonlySet<string> = new Set(["status", "history", "insights", "session", "runtime"]);

type TaskBuilder = (args: string) => Task;

export class CommandParser implements ICommandParser {
  // A flat lookup table today; structured so a future CommandRegistry can
  // supply or extend this mapping without touching the tokenizing logic below.
  private readonly commandHandlers: Record<string, TaskBuilder> = {
    analyze: (args) => ({
      type: "analyze-repository",
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
  };

  parse(text: string): ParsedCommand {
    const withoutSlash = text.trim().replace(/^\//, "");

    let repositoryId: string | undefined;
    let rest = withoutSlash;
    const repoMatch = rest.match(/^repo=(\S+)\s*/);
    if (repoMatch) {
      repositoryId = repoMatch[1];
      rest = rest.slice(repoMatch[0].length);
    }

    const [commandName, ...argWords] = rest.split(/\s+/);
    const args = argWords.join(" ");
    const normalizedCommand = commandName?.toLowerCase();

    if (normalizedCommand === "ship") {
      if (!args) {
        throw new CommandParseError('"ship" requires a message, e.g. "ship Add dark mode toggle".');
      }
      return { kind: "workflow", workflowId: "ship", input: { message: args }, repositoryId };
    }

    if (normalizedCommand && QUERY_COMMANDS.has(normalizedCommand)) {
      return { kind: "query", query: this.buildQuery(normalizedCommand, args), repositoryId };
    }

    const handler = normalizedCommand ? this.commandHandlers[normalizedCommand] : undefined;
    if (!handler) {
      throw new CommandParseError(`Sorry, I don't recognize the command "${commandName ?? ""}".`);
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
    return { type: command as "status" | "insights" | "session" };
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
        throw new CommandParseError(`Sorry, I don't recognize the runtime command "${subcommand}".`);
    }
  }
}
