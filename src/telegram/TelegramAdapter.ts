import type { IApplicationService } from "../application/interfaces";
import type { IAutonomousExecutionOrchestrator } from "../autonomousexecution/interfaces";
import type { IExecutionPipeline } from "../pipeline/interfaces";
import type { PipelineRequest } from "../pipeline/types";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import { CommandParser } from "./CommandParser";
import type {
  ICommandParser,
  IResponseFormatter,
  ITelegramAdapter,
  ITelegramCallbackHandler,
  ITelegramClient,
  ITelegramSecurity,
} from "./interfaces";
import { ResponseFormatter } from "./ResponseFormatter";
import { MAX_HISTORY_KEYBOARD_ITEMS } from "./TelegramConstants";
import { buildGitHistoryItemKeyboard } from "./TelegramKeyboardBuilder";
import { buildTelegramCorrelationId } from "./TelegramCorrelation";
import type { ApplicationQuery, InlineKeyboardButton, ParsedCommand, TelegramCallbackQuery, TelegramUpdate } from "./types";

// ExecutionPipeline is the single runtime entrypoint for engineering task
// execution — TelegramAdapter no longer holds an IControllerCore reference
// at all. Every task/workflow command submits to executionPipeline.run();
// ExecutionPipeline itself decides whether that runs through the full
// Strategy/Planning/Coordination stack or bypasses it, and is the only thing
// that ever calls ControllerCore. Query commands are unaffected — they never
// executed anything and still go straight to ApplicationService.
// Git History & Inspection System: TelegramAdapter also implements
// ITelegramCallbackHandler now -- see handleCallback() below and
// TelegramCallbackRouter's own doc comment for why a second callback
// handler can coexist with TelegramApprovalProvider's existing one without
// any change to the poller or to that class.
export class TelegramAdapter implements ITelegramAdapter, ITelegramCallbackHandler {
  constructor(
    private readonly executionPipeline: IExecutionPipeline,
    private readonly applicationService: IApplicationService,
    private readonly telegramSecurity: ITelegramSecurity,
    private readonly telegramClient: ITelegramClient,
    // Phase 12: the one place a Telegram command reaches
    // AutonomousExecutionOrchestrator. Inserted before the two defaulted
    // parameters below so neither has to move.
    private readonly autonomousExecutionOrchestrator: IAutonomousExecutionOrchestrator,
    // Repository context: an explicit repo=<id> on any command becomes the
    // active repository for every subsequent command that omits repo= —
    // set here, once parsing succeeds, before dispatch. Same reasoning as
    // autonomousExecutionOrchestrator above for where this sits in the
    // parameter list.
    private readonly repositoryRegistry: IRepositoryRegistry,
    private readonly commandParser: ICommandParser = new CommandParser(),
    private readonly responseFormatter: IResponseFormatter = new ResponseFormatter(),
  ) {}

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (!update.message) {
      return;
    }
    const { chatId, userId, text } = update.message;

    if (!this.telegramSecurity.isAuthorized(userId)) {
      await this.telegramClient.sendMessage({ chatId, text: this.responseFormatter.formatUnauthorized() });
      return;
    }

    let parsed: ParsedCommand;
    try {
      parsed = this.commandParser.parse(text);
    } catch (error) {
      await this.telegramClient.sendMessage({
        chatId,
        text: this.responseFormatter.formatCommandError(error instanceof Error ? error.message : "Sorry, I didn't understand that command."),
      });
      return;
    }

    // An explicit repo=<id> becomes the active repository so subsequent
    // commands that omit repo= resolve to it too (RepositoryRegistry is the
    // single source every repo-defaulting read already falls back to). Set
    // before dispatch, for every kind that can carry one — "autonomous-execute"
    // never does, since it picks its own repository from the schedule.
    if (parsed.kind !== "autonomous-execute" && parsed.repositoryId) {
      try {
        this.repositoryRegistry.setActiveRepository(parsed.repositoryId);
      } catch (error) {
        await this.telegramClient.sendMessage({ chatId, text: this.responseFormatter.formatUnexpectedError(error) });
        return;
      }
    }

    if (parsed.kind === "query") {
      // "artifact-get" sends the artifact's own content back as a document,
      // not a formatted text reply -- handled here, before the generic
      // handleQuery() switch every other query type goes through, the same
      // way "autonomous-execute" below sits outside the "task"/"workflow"
      // pipeline path.
      if (parsed.query.type === "artifact-get") {
        await this.handleArtifactGet(chatId, parsed.query.id);
        return;
      }
      // Git History & Inspection System: "/history" is the one query type
      // whose reply carries an inline keyboard (one row of buttons per
      // commit) -- handled here, before the generic handleQuery() switch
      // (which only ever returns plain text), the same way "artifact-get"
      // above sits outside it for its own different reason.
      if (parsed.query.type === "git-history") {
        await this.handleGitHistory(chatId, parsed.query, parsed.repositoryId);
        return;
      }
      try {
        const text = await this.handleQuery(parsed.query, parsed.repositoryId, this.telegramSecurity.isAdmin(userId));
        await this.telegramClient.sendMessage({ chatId, text });
      } catch (error) {
        await this.telegramClient.sendMessage({ chatId, text: this.responseFormatter.formatUnexpectedError(error) });
      }
      return;
    }

    // Built once here, before either remaining branch, since both need it:
    // the existing task/workflow path (below) and the new autonomous-execute
    // path each pass this same real chat/update-derived id into a "pipeline"
    // request, exactly as buildTelegramCorrelationId's own doc comment
    // anticipates for TelegramApprovalProvider to route an approval prompt
    // back to this chat.
    const correlationId = buildTelegramCorrelationId(chatId, update.updateId);

    if (parsed.kind === "autonomous-execute") {
      try {
        const result = await this.autonomousExecutionOrchestrator.attemptExecution(correlationId);
        await this.telegramClient.sendMessage({ chatId, text: this.responseFormatter.formatAutonomousExecutionResult(result) });
      } catch (error) {
        await this.telegramClient.sendMessage({ chatId, text: this.responseFormatter.formatUnexpectedError(error) });
      }
      return;
    }

    const pipelineRequest = this.buildPipelineRequest(parsed, correlationId);

    try {
      const result = await this.executionPipeline.run(pipelineRequest);
      await this.telegramClient.sendMessage({ chatId, text: this.responseFormatter.formatPipelineResult(result) });
    } catch (error) {
      await this.telegramClient.sendMessage({ chatId, text: this.responseFormatter.formatUnexpectedError(error) });
    }
  }

  // "/ship" is the one command that still parses to kind: "workflow" — it
  // becomes a "pipeline" PipelineRequest, not a "task" one, so
  // ExecutionPipeline never mistakes it for a standalone "/commit" even
  // though both end up represented internally as a create-commit Task (see
  // ExecutionPipeline.resolveTask for why that distinction has to live in
  // the request kind, not the Task shape).
  private buildPipelineRequest(parsed: Extract<ParsedCommand, { kind: "task" | "workflow" }>, correlationId: string): PipelineRequest {
    if (parsed.kind === "task") {
      return { kind: "task", task: parsed.task, repositoryId: parsed.repositoryId, correlationId };
    }
    if (parsed.workflowId !== "ship") {
      throw new Error(`No pipeline translation exists for workflow "${parsed.workflowId}".`);
    }
    const message = typeof parsed.input.message === "string" ? parsed.input.message : "";
    return { kind: "pipeline", message, repositoryId: parsed.repositoryId, correlationId };
  }

  // Fetches the artifact's content and uploads it as a Telegram document --
  // the one query type that never becomes a formatted text sendMessage.
  // "Not found" and unexpected errors still degrade to an ordinary text
  // reply, same as every other query.
  private async handleArtifactGet(chatId: number, id: string): Promise<void> {
    try {
      const content = await this.applicationService.getArtifactContent(id);
      if (!content) {
        await this.telegramClient.sendMessage({ chatId, text: this.responseFormatter.formatArtifactNotFound(id) });
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of content.data) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      await this.telegramClient.sendDocument({
        chatId,
        filename: content.metadata.filename,
        content: Buffer.concat(chunks),
        caption: this.responseFormatter.formatArtifactCaption(content.metadata),
      });
    } catch (error) {
      await this.telegramClient.sendMessage({ chatId, text: this.responseFormatter.formatUnexpectedError(error) });
    }
  }

  // Git History & Inspection System: "/history"'s own handling, outside the
  // generic handleQuery() switch -- attaches one inline keyboard row per
  // commit (buildGitHistoryItemKeyboard), keyed by GitHistoryResult's own
  // resolved repositoryId so a later tap always targets the repository this
  // listing actually came from. TELEGRAM_MAX_MESSAGE_LENGTH-based splitting
  // and "keyboard on the final chunk only" are already handled by
  // ITelegramClient.sendMessage()/splitMessageText -- no pagination logic
  // of its own is needed here.
  private async handleGitHistory(
    chatId: number,
    query: Extract<ApplicationQuery, { type: "git-history" }>,
    repositoryId: string | undefined,
  ): Promise<void> {
    try {
      const result = await this.applicationService.getCommitHistory(repositoryId, {
        limit: query.limit,
        branch: query.branch,
        author: query.author,
        search: query.search,
      });
      const text = this.responseFormatter.formatGitHistory(result);
      // Capped independently of how many commits are actually shown in
      // `text` above -- every commit stays listed (and reachable via
      // /show, /diff, /undo <hash>), only the button rows are bounded so a
      // large /history reply never attaches an unusably large keyboard.
      const inlineKeyboard: InlineKeyboardButton[][] = result.commits
        .slice(0, MAX_HISTORY_KEYBOARD_ITEMS)
        .flatMap((commit) => buildGitHistoryItemKeyboard(result.repositoryId, commit.shortSha));
      await this.telegramClient.sendMessage({ chatId, text, inlineKeyboard: inlineKeyboard.length > 0 ? inlineKeyboard : undefined });
    } catch (error) {
      await this.telegramClient.sendMessage({ chatId, text: this.responseFormatter.formatUnexpectedError(error) });
    }
  }

  // Git History & Inspection System: the Show/Diff/Undo inline buttons
  // /history attaches to each commit -- callback_data is
  // "history:<action>:<repositoryId>:<shortSha>". Unlike TelegramApprovalProvider's
  // correlationId (which contains colons and needs "everything after the
  // second colon" capture), a repository id and a git short hash can never
  // contain one, so a plain split is always correct here. Ignores anything
  // it doesn't own (no match, or an unrecognized action) so it can be
  // called unconditionally by TelegramCallbackRouter alongside
  // TelegramApprovalProvider's own handleCallback -- the same self-filtering
  // contract every ITelegramCallbackHandler in this codebase already follows.
  async handleCallback(callbackQuery: TelegramCallbackQuery): Promise<void> {
    const match = callbackQuery.data.match(/^history:(show|diff|undo):([^:]+):(.+)$/);
    if (!match) {
      return;
    }
    const [, action, repositoryId, shortSha] = match;

    if (!this.telegramSecurity.isAuthorized(callbackQuery.userId)) {
      await this.telegramClient.answerCallbackQuery(callbackQuery.id, "You are not authorized to use this bot.");
      return;
    }

    try {
      const text = await this.handleQuery(this.buildGitHistoryActionQuery(action, shortSha), repositoryId, this.telegramSecurity.isAdmin(callbackQuery.userId));
      await this.telegramClient.answerCallbackQuery(callbackQuery.id);
      await this.telegramClient.sendMessage({ chatId: callbackQuery.chatId, text });
    } catch (error) {
      await this.telegramClient.answerCallbackQuery(callbackQuery.id, "Something went wrong.");
      await this.telegramClient.sendMessage({ chatId: callbackQuery.chatId, text: this.responseFormatter.formatUnexpectedError(error) });
    }
  }

  // The one place a callback action name becomes the exact same query a
  // manually-typed "/show <hash>"/"/diff <hash>"/"/undo <hash>" would build
  // -- handleCallback() and the manual command path share every byte of
  // logic downstream of this, via the same handleQuery() switch. Adding a
  // future action here (Cherry-pick, Checkout, Blame, ...) is one more case,
  // never a parallel implementation.
  private buildGitHistoryActionQuery(action: string, shortSha: string): Exclude<ApplicationQuery, { type: "artifact-get" } | { type: "git-history" }> {
    switch (action) {
      case "show":
        return { type: "git-show", hash: shortSha };
      case "diff":
        return { type: "git-diff", hash: shortSha };
      default:
        return { type: "undo", target: shortSha };
    }
  }

  // Phase 8.10: each "runtime-*" case calls ApplicationService.getRuntimeReport()
  // exactly once, within that case alone — the switch executes exactly one
  // case per call, so no runtime query ever fetches the report more than
  // once. No new ApplicationService method exists for any of these views;
  // all five are different selections over the same RuntimeReport, decided
  // entirely inside ResponseFormatter.
  //
  // Artifact Management: "artifact-delete"/"artifact-delete-all"/
  // "artifact-rebuild-index" are the only cases that consult isAdmin --
  // every other case here is exactly as available to a non-admin authorized
  // user as it always was.
  private async handleQuery(
    query: Exclude<ApplicationQuery, { type: "artifact-get" } | { type: "git-history" }>,
    repositoryId: string | undefined,
    isAdmin: boolean,
  ): Promise<string> {
    switch (query.type) {
      case "status":
        return this.responseFormatter.formatRepositoryStatus(await this.applicationService.getRepositoryStatus(repositoryId));
      case "task-history":
        return this.responseFormatter.formatTaskHistory(
          await this.applicationService.getTaskExecutionHistory(repositoryId, query.limit),
        );
      case "git-show":
        return this.responseFormatter.formatCommitDetail(await this.applicationService.getCommitDetail(repositoryId, query.hash));
      case "git-diff":
        return this.responseFormatter.formatCommitDiff(await this.applicationService.getCommitDiffStat(repositoryId, query.hash));
      case "insights":
        return this.responseFormatter.formatInsights(await this.applicationService.getRepositoryInsights(repositoryId));
      case "failures":
        return this.responseFormatter.formatFailureStatus(await this.applicationService.getFailureStatus(repositoryId));
      case "clear-failures":
        return this.responseFormatter.formatClearFailuresResult(
          await this.applicationService.clearFailures(repositoryId, query.taskType),
        );
      case "session":
        return this.responseFormatter.formatSessionStatus(this.applicationService.getSessionStatus(repositoryId));
      case "session-reset":
        return this.responseFormatter.formatSessionResetResult(this.applicationService.resetSession(repositoryId));
      case "session-stop":
        return this.responseFormatter.formatSessionStopResult(this.applicationService.stopSession(repositoryId));
      case "help":
        return this.responseFormatter.formatHelp();
      case "recommendations":
        return this.responseFormatter.formatRecommendations(await this.applicationService.getRecommendations(repositoryId));
      case "branch":
        return this.responseFormatter.formatBranch(await this.applicationService.getRepositoryStatus(repositoryId));
      case "branches":
        return this.responseFormatter.formatBranches(await this.applicationService.getRepositoryStatus(repositoryId));
      case "task":
        return this.responseFormatter.formatCurrentTask(this.applicationService.getCurrentTask(repositoryId));
      case "task-cancel":
        return this.responseFormatter.formatCancelResult(this.applicationService.cancelCurrentTask(repositoryId));
      case "undo":
        return this.responseFormatter.formatUndoResult(await this.applicationService.undoLastExecution(repositoryId, query.target));
      case "health":
        return this.responseFormatter.formatRepositoryHealth(await this.applicationService.getRepositoryHealth(repositoryId));
      case "recover":
        return this.responseFormatter.formatRecoveryResult(await this.applicationService.recoverRepository(repositoryId));
      case "resume":
        return this.responseFormatter.formatResumeResult(await this.applicationService.resumeRepositoryOperation(repositoryId));
      case "abort":
        return this.responseFormatter.formatAbortResult(await this.applicationService.abortRepositoryOperation(repositoryId));
      case "working-tree-changes":
        return this.responseFormatter.formatWorkingTreeChanges(await this.applicationService.getWorkingTreeChanges(repositoryId));
      case "working-tree-change-diff":
        return this.responseFormatter.formatWorkingTreeChangeDiff(
          await this.applicationService.getWorkingTreeChangeDiff(repositoryId, query.index),
        );
      case "discard-change":
        return this.responseFormatter.formatDiscardResult(
          await this.applicationService.discardWorkingTreeChange(repositoryId, query.index, query.confirmed),
        );
      case "discard-all":
        return this.responseFormatter.formatDiscardResult(
          await this.applicationService.discardAllWorkingTreeChanges(repositoryId, query.confirmed),
        );
      case "runtime-report":
        return this.responseFormatter.formatRuntimeReport(this.applicationService.getRuntimeReport());
      case "runtime-status":
        return this.responseFormatter.formatRuntimeStatus(this.applicationService.getRuntimeReport());
      case "runtime-diagnostics":
        return this.responseFormatter.formatRuntimeDiagnostics(this.applicationService.getRuntimeReport());
      case "runtime-monitoring":
        return this.responseFormatter.formatRuntimeMonitoring(this.applicationService.getRuntimeReport());
      case "runtime-policy":
        return this.responseFormatter.formatRuntimePolicy(this.applicationService.getRuntimeReport());
      case "artifact-list":
        return this.responseFormatter.formatArtifactList(await this.applicationService.listArtifacts(repositoryId));
      case "artifact-search":
        return this.responseFormatter.formatArtifactSearchResults(
          query.query,
          await this.applicationService.searchArtifacts(query.query, repositoryId),
        );
      case "artifact-delete":
        if (!isAdmin) {
          return this.responseFormatter.formatUnauthorized();
        }
        return this.responseFormatter.formatArtifactDeleteResult(await this.applicationService.deleteArtifacts(query.ids));
      case "artifact-delete-all": {
        if (!isAdmin) {
          return this.responseFormatter.formatUnauthorized();
        }
        const outcome = await this.applicationService.deleteAllArtifacts(query.confirmed);
        return query.confirmed
          ? this.responseFormatter.formatArtifactDeleteAllResult(outcome)
          : this.responseFormatter.formatArtifactDeleteAllConfirmation(outcome.totalRemaining);
      }
      case "artifact-rebuild-index":
        if (!isAdmin) {
          return this.responseFormatter.formatUnauthorized();
        }
        return this.responseFormatter.formatArtifactIndexRebuildResult(await this.applicationService.rebuildArtifactIndex());
    }
  }
}
