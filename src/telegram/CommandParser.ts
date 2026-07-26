import { DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT } from "../git/GitConstants";
import type { Task } from "../planner/types";
import { CommandParseError } from "./errors";
import type { ICommandParser } from "./interfaces";
import type { ApplicationQuery, ParsedCommand } from "./types";

const REPO_TOKEN = /^repo=(\S+)$/;

const QUERY_COMMANDS: ReadonlySet<string> = new Set([
  "status",
  "insights",
  "runtime",
  "help",
  "recommendations",
  "branches",
  // Git Orchestration redesign: /health is a pure read; /recover, /resume,
  // and /abort each trigger a targeted side effect while answering, the
  // same way /task cancel already does despite being "query" kind -- none
  // of them build a Task domain object or go through ExecutionPipeline.
  // ("history" and "undo" moved out to their own special-cased blocks in
  // parse() -- see buildGitHistoryQuery()/the "undo" branch below -- since
  // both now take their own argument syntax the generic dispatch here
  // can't express.)
  "health",
  "recover",
  "resume",
  "abort",
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
    // Unlike "merge", a bare "/rebase" (no argument) is a common, safe
    // request -- RebaseWorkflow itself resolves the branch's own configured
    // upstream when "onto" is omitted (see RebaseTask's own doc comment).
    rebase: (args) => ({ type: "rebase", input: args ? { onto: args } : undefined }),
  };

  parse(text: string): ParsedCommand {
    const tokens = text.trim().split(/\s+/).filter((token) => token.length > 0);

    // repo=<id> is recognized only in two fixed positions: immediately
    // before the command name (token 0), or immediately after it (the token
    // right after the command name). This parser never looks past position
    // two for one -- a repo=<id>-shaped token appearing later is left
    // completely alone, so it stays as ordinary argument/description text
    // (e.g. "/implement Add support for repo=test query parameter" must
    // reach Claude unchanged). Module-scoped (not local to this method) so
    // extractTrailingRepo() below -- a separate method, needed for its own
    // trailing-scan logic history/show/diff/undo use -- can reuse the exact
    // same pattern rather than a second, independently-maintained regex.
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

    // "artifact" is a command family (bare /artifact, /artifact get|search|
    // delete) -- handled here the same way "task"/"session" are above. No
    // trailing repo= scan of its own: none of its subcommands are repo-
    // scoped the way "task cancel"/"session reset" are (an artifact id is
    // globally unique, never repository-relative).
    if (normalizedCommand === "artifact") {
      return { kind: "query", query: this.buildArtifactQuery(args), repositoryId };
    }

    // Git History & Inspection System: "/history" takes its own argument
    // syntax (a bare count, or exactly one of branch:/author:/search:) the
    // generic QUERY_COMMANDS dispatch below can't express -- handled here,
    // the same way "branch"/"task"/"session"/"artifact" already are.
    // Every one of history/show/diff/undo's own arguments is a closed shape
    // (a filter prefix, a commit hash, the literal "confirm") -- never
    // multi-word free text a trailing "repo=x" could be mistaken for part
    // of -- so, like "task"/"session" above, a trailing repo=<id> is safe to
    // recognize here even though the shared REPO_TOKEN logic at the top of
    // this method only scans position 0/1.
    if (normalizedCommand === "history") {
      const { text, repositoryId: resolvedRepositoryId } = this.extractTrailingRepo(args, repositoryId);
      return { kind: "query", query: this.buildGitHistoryQuery(text), repositoryId: resolvedRepositoryId };
    }

    // "/show <hash>" and "/diff <hash>" both address one commit by a
    // user-typed reference -- only the first whitespace-delimited token is
    // ever taken as the hash, so trailing garbage (other than a trailing
    // repo=<id>, extracted first) is silently ignored rather than rejected
    // (git itself is the final authority on whether the hash resolves, via
    // GitHistoryService).
    if (normalizedCommand === "show") {
      const { text, repositoryId: resolvedRepositoryId } = this.extractTrailingRepo(args, repositoryId);
      const hash = text.trim().split(/\s+/)[0];
      if (!hash) throw new CommandParseError('"show" requires a commit hash, e.g. "show 6739c2e".');
      return { kind: "query", query: { type: "git-show", hash }, repositoryId: resolvedRepositoryId };
    }
    if (normalizedCommand === "diff") {
      const { text, repositoryId: resolvedRepositoryId } = this.extractTrailingRepo(args, repositoryId);
      const hash = text.trim().split(/\s+/)[0];
      if (!hash) throw new CommandParseError('"diff" requires a commit hash, e.g. "diff 6739c2e".');
      return { kind: "query", query: { type: "git-diff", hash }, repositoryId: resolvedRepositoryId };
    }

    // Git History & Inspection System: a bare "/undo" is now a preview only
    // (see ApplicationService.undoLastExecution()'s own doc comment) --
    // moved out of the generic QUERY_COMMANDS dispatch below, which could
    // only ever produce the argument-less { type: "undo" } shape, to also
    // accept the literal "confirm" or a commit hash/prefix.
    if (normalizedCommand === "undo") {
      const { text, repositoryId: resolvedRepositoryId } = this.extractTrailingRepo(args, repositoryId);
      const target = text.trim().split(/\s+/)[0];
      return { kind: "query", query: target ? { type: "undo", target } : { type: "undo" }, repositoryId: resolvedRepositoryId };
    }

    // Working Tree Management: "/changes" lists every local working-tree
    // change with a stable index each file keeps for the lifetime of that
    // one listing -- no arguments of its own beyond the shared repo=
    // handling every bare, top-level command already gets.
    if (normalizedCommand === "changes") {
      const { repositoryId: resolvedRepositoryId } = this.extractTrailingRepo(args, repositoryId);
      return { kind: "query", query: { type: "working-tree-changes" }, repositoryId: resolvedRepositoryId };
    }

    // "/showchanges <index>" -- index refers to /changes' own numbering,
    // never a commit hash (that's /diff <hash>'s job) -- rejecting anything
    // that isn't a positive integer here, the same "git itself is not the
    // authority, this is our own concept" precedent WorkingTreeChangeNotFoundError
    // documents for the not-found case.
    if (normalizedCommand === "showchanges") {
      const { text, repositoryId: resolvedRepositoryId } = this.extractTrailingRepo(args, repositoryId);
      const index = this.tryParsePositiveIndex(text.trim().split(/\s+/)[0]);
      if (index === undefined) {
        throw new CommandParseError('"showchanges" requires a positive index from /changes, e.g. "showchanges 2".');
      }
      return { kind: "query", query: { type: "working-tree-change-diff", index }, repositoryId: resolvedRepositoryId };
    }

    // "/discard" is a command family whose kind depends on its own
    // arguments, the same split "branch" already uses for itself: a bare
    // "/discard" (no args) stays exactly what it always was -- a task-kind
    // command, unconfirmed, whole-tree, routed through DiscardWorkflow.
    // "/discard <index>", "/discard <index> confirm", "/discard all", and
    // "/discard all confirm" are the new Working Tree Management family
    // instead -- query-kind, always requiring the literal "confirm" token
    // (re-supplied alongside its own target, never a bare "/discard confirm"
    // on its own, since there is no session state anywhere in this codebase
    // to remember *which* target an earlier, separate "/discard <index>"
    // request was about -- see ApplicationService.discardWorkingTreeChange's
    // own doc comment) before anything is actually discarded.
    if (normalizedCommand === "discard") {
      const { text, repositoryId: resolvedRepositoryId } = this.extractTrailingRepo(args, repositoryId);
      const discardTokens = text.trim().split(/\s+/).filter((token) => token.length > 0);
      if (discardTokens.length === 0) {
        return { kind: "task", task: { type: "discard" }, repositoryId: resolvedRepositoryId };
      }

      const confirmed = discardTokens[discardTokens.length - 1].toLowerCase() === "confirm";
      const targetTokens = confirmed ? discardTokens.slice(0, -1) : discardTokens;

      if (targetTokens.length === 1 && targetTokens[0].toLowerCase() === "all") {
        return { kind: "query", query: { type: "discard-all", confirmed }, repositoryId: resolvedRepositoryId };
      }
      const index = targetTokens.length === 1 ? this.tryParsePositiveIndex(targetTokens[0]) : undefined;
      if (index !== undefined) {
        return { kind: "query", query: { type: "discard-change", index, confirmed }, repositoryId: resolvedRepositoryId };
      }
      throw new CommandParseError(
        '"discard" takes an index from /changes (e.g. "discard 2", then "discard 2 confirm"), ' +
          '"all" (e.g. "discard all", then "discard all confirm"), or no argument to discard everything immediately.',
      );
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
    if (command === "runtime") {
      return this.buildRuntimeQuery(args);
    }
    return { type: command as "status" | "insights" | "help" | "recommendations" | "branches" | "health" | "recover" | "resume" | "abort" };
  }

  // Git History & Inspection System: "/history" recognizes exactly one of a
  // bare count or a branch:/author:/search: prefix per call, matching every
  // example the feature was specified with -- never combined in one
  // invocation. Prefix matching is case-insensitive ("Branch:main" works),
  // but the filter value itself keeps whatever case the user typed (an
  // author name or search text is meaningfully case-sensitive).
  private buildGitHistoryQuery(args: string): ApplicationQuery {
    const trimmed = args.trim();
    if (!trimmed) {
      return { type: "git-history", limit: DEFAULT_HISTORY_LIMIT };
    }

    const lower = trimmed.toLowerCase();
    if (lower.startsWith("branch:")) {
      const branch = trimmed.slice("branch:".length).trim();
      if (!branch) throw new CommandParseError('"history branch:" requires a branch name, e.g. "history branch:main".');
      return { type: "git-history", branch };
    }
    if (lower.startsWith("author:")) {
      const author = trimmed.slice("author:".length).trim();
      if (!author) throw new CommandParseError('"history author:" requires an author name, e.g. "history author:Taijul".');
      return { type: "git-history", author };
    }
    if (lower.startsWith("search:")) {
      const search = trimmed.slice("search:".length).trim();
      if (!search) throw new CommandParseError('"history search:" requires search text, e.g. "history search:payment".');
      return { type: "git-history", search };
    }

    const limit = Number.parseInt(trimmed, 10);
    if (Number.isNaN(limit) || limit <= 0) {
      throw new CommandParseError(
        `"history" takes an optional positive number (max ${MAX_HISTORY_LIMIT}) or a branch:/author:/search: filter, e.g. "history 20", "history branch:main".`,
      );
    }
    // Silently capped, not rejected -- /history always returns something
    // useful rather than making the user retry with a smaller number.
    return { type: "git-history", limit: Math.min(limit, MAX_HISTORY_LIMIT) };
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
      default: {
        // Renamed from the old bare "/history": now "/task history [limit]",
        // freeing "/history" for the Git History & Inspection System's own
        // commit log. subcommand is already lowercased by the caller (see
        // the "task" branch in parse()), same as "cancel" above.
        if (subcommand === "history" || subcommand.startsWith("history ")) {
          const limitText = subcommand.slice("history".length).trim();
          if (!limitText) {
            return { type: "task-history" };
          }
          const limit = Number.parseInt(limitText, 10);
          if (Number.isNaN(limit) || limit <= 0) {
            throw new CommandParseError('"task history" takes an optional positive number, e.g. "task history 10".');
          }
          return { type: "task-history", limit };
        }
        throw this.unrecognized("task command", subcommand);
      }
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

  // A bare "/artifact" (subcommand === "") lists recent artifacts; "get",
  // "search", and "delete" are the three other members of the family. An
  // unrecognized subcommand falls through to the same CommandParseError
  // every other unrecognized command already throws.
  private buildArtifactQuery(argsText: string): ApplicationQuery {
    const tokens = argsText.split(/\s+/).filter((token) => token.length > 0);
    const subcommand = tokens[0]?.toLowerCase() ?? "";
    const rest = tokens.slice(1).join(" ");

    switch (subcommand) {
      case "":
        return { type: "artifact-list" };
      case "get":
        if (!rest) throw new CommandParseError('"artifact get" requires an artifact id, e.g. "artifact get <id>".');
        return { type: "artifact-get", id: rest };
      case "search":
        if (!rest) throw new CommandParseError('"artifact search" requires a query, e.g. "artifact search fix summary".');
        return { type: "artifact-search", query: rest };
      case "delete": {
        const ids = tokens.slice(1);
        if (ids.length === 0) {
          throw new CommandParseError(
            '"artifact delete" requires one or more artifact ids, e.g. "artifact delete <id>" or "artifact delete <id1> <id2> <id3>".',
          );
        }
        return { type: "artifact-delete", ids };
      }
      // Deliberately requires the literal "confirm" token, not just a bare
      // "/artifact delete-all" -- the one command in this family that
      // deletes without a specific id, so it gets its own explicit,
      // must-be-typed-out safety gate, the same "no implicit convenience"
      // philosophy "/merge" already applies to a different kind of
      // significant operation. CommandParser never performs the deletion
      // itself either way; confirmed only tells ApplicationService whether
      // the user actually opted in.
      case "delete-all":
        return { type: "artifact-delete-all", confirmed: rest.toLowerCase() === "confirm" };
      case "rebuild-index":
        return { type: "artifact-rebuild-index" };
      default:
        throw this.unrecognized("artifact command", subcommand);
    }
  }

  // The one place every "I don't recognize X" message is built -- previously
  // duplicated (with a slightly different phrase each time) at all three
  // call sites above. Standardized wording plus a consistent pointer to
  // /help, since none of the three previously told the user where to look.
  private unrecognized(label: string, name: string): CommandParseError {
    return new CommandParseError(`Sorry, I don't recognize the ${label} "${name}". Send /help to see available commands.`);
  }

  // Working Tree Management: shared by "/showchanges <index>" and
  // "/discard <index>"'s own index parsing -- a positive integer only
  // (indexes from /changes start at 1), undefined for anything else
  // (including "0", a negative number, or non-numeric text) so each call
  // site can throw its own, differently-worded CommandParseError rather than
  // this one throwing a message that fits neither.
  private tryParsePositiveIndex(token: string | undefined): number | undefined {
    if (!token || !/^\d+$/.test(token)) {
      return undefined;
    }
    const index = Number.parseInt(token, 10);
    return index > 0 ? index : undefined;
  }

  // Git History & Inspection System: shared by history/show/diff/undo's own
  // trailing repo= scan above (see their call sites for why it's safe for
  // these four specifically) -- the same logic "task"/"session" already
  // duplicate inline for themselves; factored out here rather than a third
  // and fourth copy, without touching their own already-working versions.
  // Only ever overrides repositoryId when the caller didn't already resolve
  // one from the shared position-0/1 REPO_TOKEN logic at the top of parse().
  private extractTrailingRepo(args: string, repositoryId: string | undefined): { text: string; repositoryId: string | undefined } {
    const tokens = args.split(/\s+/).filter((token) => token.length > 0);
    const trailingMatch = tokens[tokens.length - 1]?.match(REPO_TOKEN);
    if (trailingMatch && repositoryId === undefined) {
      tokens.pop();
      return { text: tokens.join(" "), repositoryId: trailingMatch[1] };
    }
    return { text: args, repositoryId };
  }
}
