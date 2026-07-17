import type { ExecutionResult } from "../controller/types";
import type { RepositoryInsightReport } from "../decisions/types";
import type { RepositorySnapshot } from "../intelligence/types";
import type { ProjectMemoryEvent } from "../memory/types";
import type { PipelineResult } from "../pipeline/types";
import type { RuntimeReport } from "../reporting/types";
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
  // Phase 12: result is exactly what AutonomousExecutionOrchestrator.attemptExecution()
  // returned -- undefined means nothing eligible was found, never a
  // fabricated report standing in for a real attempt.
  formatAutonomousExecutionResult(result: PipelineResult | undefined): string;
  // Phase 8.10: all five consume the same RuntimeReport shape and only
  // select/join its already-produced title/health/summary/section content —
  // none of them reformat a value, reinterpret a finding, or parse a
  // severity string. RuntimeReportingEngine remains the only place that
  // content is produced.
  formatRuntimeReport(report: RuntimeReport): string;
  formatRuntimeStatus(report: RuntimeReport): string;
  formatRuntimeDiagnostics(report: RuntimeReport): string;
  formatRuntimeMonitoring(report: RuntimeReport): string;
  formatRuntimePolicy(report: RuntimeReport): string;
}

export interface ITelegramSecurity {
  isAuthorized(userId: number): boolean;
}
