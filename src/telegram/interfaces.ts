import type { ExecutionResult } from "../controller/types";
import type { RepositoryInsightReport } from "../decisions/types";
import type { RepositorySnapshot } from "../intelligence/types";
import type { ProjectMemoryEvent } from "../memory/types";
import type { PipelineResult } from "../pipeline/types";
import type { ClaudeSessionInfo } from "../session/types";
import type { OutgoingMessage, ParsedCommand, TelegramCallbackQuery, TelegramUpdate } from "./types";

export interface ITelegramAdapter {
  handleUpdate(update: TelegramUpdate): Promise<void>;
}

export interface ITelegramClient {
  sendMessage(message: OutgoingMessage): Promise<void>;
  getUpdates(offset?: number, timeoutSeconds?: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
}

export interface ITelegramTransport {
  start(): Promise<void>;
  stop(): void;
}

export interface ITelegramCallbackHandler {
  handleCallback(callbackQuery: TelegramCallbackQuery): Promise<void>;
}

export interface ICommandParser {
  parse(text: string): ParsedCommand;
}

export interface IResponseFormatter {
  format(result: ExecutionResult): string;
  formatRepositoryStatus(snapshot: RepositorySnapshot): string;
  formatHistory(events: ProjectMemoryEvent[]): string;
  formatInsights(report: RepositoryInsightReport): string;
  formatSessionStatus(info: ClaudeSessionInfo | undefined): string;
  formatPipelineResult(result: PipelineResult): string;
}

export interface ITelegramSecurity {
  isAuthorized(userId: number): boolean;
}
