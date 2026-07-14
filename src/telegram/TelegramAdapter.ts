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
import type { ParsedCommand, TelegramUpdate } from "./types";

export class TelegramAdapter implements ITelegramAdapter {
  constructor(
    private readonly controllerCore: IControllerCore,
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
}
