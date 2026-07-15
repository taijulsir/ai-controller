import type { IApplicationService } from "../application/interfaces";
import type { IExecutionPipeline } from "../pipeline/interfaces";
import type { PipelineRequest } from "../pipeline/types";
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
    private readonly commandParser: ICommandParser = new CommandParser(),
    private readonly responseFormatter: IResponseFormatter = new ResponseFormatter(),
  ) {}

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (!update.message) {
      return;
    }
    const { chatId, userId, text } = update.message;

    if (!this.telegramSecurity.isAuthorized(userId)) {
      await this.telegramClient.sendMessage({ chatId, text: "You are not authorized to use this bot." });
      return;
    }

    let parsed: ParsedCommand;
    try {
      parsed = this.commandParser.parse(text);
    } catch (error) {
      await this.telegramClient.sendMessage({
        chatId,
        text: error instanceof Error ? error.message : "Sorry, I didn't understand that command.",
      });
      return;
    }

    if (parsed.kind === "query") {
      try {
        const text = await this.handleQuery(parsed.query, parsed.repositoryId);
        await this.telegramClient.sendMessage({ chatId, text });
      } catch (error) {
        await this.telegramClient.sendMessage({
          chatId,
          text: `Something went wrong: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }

    const correlationId = buildTelegramCorrelationId(chatId, update.updateId);
    const pipelineRequest = this.buildPipelineRequest(parsed, correlationId);

    try {
      const result = await this.executionPipeline.run(pipelineRequest);
      await this.telegramClient.sendMessage({ chatId, text: this.responseFormatter.formatPipelineResult(result) });
    } catch (error) {
      await this.telegramClient.sendMessage({
        chatId,
        text: `Something went wrong: ${error instanceof Error ? error.message : String(error)}`,
      });
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
    }
  }
}
