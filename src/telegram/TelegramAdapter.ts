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
  ITelegramClient,
  ITelegramSecurity,
} from "./interfaces";
import { ResponseFormatter } from "./ResponseFormatter";
import { buildTelegramCorrelationId } from "./TelegramCorrelation";
import type { ApplicationQuery, ParsedCommand, TelegramUpdate } from "./types";

// ExecutionPipeline is the single runtime entrypoint for engineering task
// execution — TelegramAdapter no longer holds an IControllerCore reference
// at all. Every task/workflow command submits to executionPipeline.run();
// ExecutionPipeline itself decides whether that runs through the full
// Strategy/Planning/Coordination stack or bypasses it, and is the only thing
// that ever calls ControllerCore. Query commands are unaffected — they never
// executed anything and still go straight to ApplicationService.
export class TelegramAdapter implements ITelegramAdapter {
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
      try {
        const text = await this.handleQuery(parsed.query, parsed.repositoryId);
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

  // Phase 8.10: each "runtime-*" case calls ApplicationService.getRuntimeReport()
  // exactly once, within that case alone — the switch executes exactly one
  // case per call, so no runtime query ever fetches the report more than
  // once. No new ApplicationService method exists for any of these views;
  // all five are different selections over the same RuntimeReport, decided
  // entirely inside ResponseFormatter.
  private async handleQuery(query: ApplicationQuery, repositoryId?: string): Promise<string> {
    switch (query.type) {
      case "status":
        return this.responseFormatter.formatRepositoryStatus(await this.applicationService.getRepositoryStatus(repositoryId));
      case "history":
        return this.responseFormatter.formatHistory(
          await this.applicationService.getRepositoryHistory(repositoryId, query.limit),
        );
      case "insights":
        return this.responseFormatter.formatInsights(await this.applicationService.getRepositoryInsights(repositoryId));
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
        return this.responseFormatter.formatUndoResult(await this.applicationService.undoLastExecution(repositoryId));
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
    }
  }
}
