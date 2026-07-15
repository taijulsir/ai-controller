import type { IApplicationService } from "../application/interfaces";
import type { IControllerCore } from "../controller/interfaces";
import type { ExecutionRequest } from "../controller/types";
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

export class TelegramAdapter implements ITelegramAdapter {
  constructor(
    private readonly controllerCore: IControllerCore,
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
    const request: ExecutionRequest =
      parsed.kind === "workflow"
        ? { kind: "workflow", workflowId: parsed.workflowId, input: parsed.input, repositoryId: parsed.repositoryId, correlationId }
        : { kind: "task", task: parsed.task, repositoryId: parsed.repositoryId, correlationId };

    try {
      const result = await this.controllerCore.execute(request);
      await this.telegramClient.sendMessage({ chatId, text: this.responseFormatter.format(result) });
    } catch (error) {
      await this.telegramClient.sendMessage({
        chatId,
        text: `Something went wrong: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
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
