import type { Task } from "../planner/types";
import { CommandParseError } from "./errors";
import type { ICommandParser } from "./interfaces";
import type { ParsedCommand } from "./types";

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
    const handler = commandName ? this.commandHandlers[commandName.toLowerCase()] : undefined;

    if (!handler) {
      throw new CommandParseError(`Sorry, I don't recognize the command "${commandName ?? ""}".`);
    }

    return { task: handler(argWords.join(" ")), repositoryId };
  }
}
