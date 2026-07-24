import type { ArtifactList, ArtifactMetadata } from "../artifacts";
import type { ExecutionResult } from "../controller/types";
import type { RepositoryInsightReport } from "../decisions/types";
import type { CurrentTaskReport, TaskCancellationOutcome } from "../executionstate/types";
import type { RepositorySnapshot } from "../intelligence/types";
import type { ProjectMemoryEvent } from "../memory/types";
import type { PipelineResult } from "../pipeline/types";
import type { RepositoryRecommendationReport } from "../recommendations/types";
import type { RuntimeReport } from "../reporting/types";
import type { SessionReport, SessionStopOutcome } from "../session/types";
import type { UndoOutcome } from "../undo/types";
import type { BotCommand, OutgoingDocument, OutgoingMessage, ParsedCommand, TelegramCallbackQuery, TelegramUpdate } from "./types";

export interface ITelegramAdapter {
  handleUpdate(update: TelegramUpdate): Promise<void>;
}

export interface ITelegramClient {
  sendMessage(message: OutgoingMessage): Promise<void>;
  // Artifact Management: the one place a reply carries a real file rather
  // than text -- "/artifact get <id>" sends the artifact's own content this
  // way instead of inlining it into a message body.
  sendDocument(document: OutgoingDocument): Promise<void>;
  getUpdates(offset?: number, timeoutSeconds?: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  // Registers the bot's own command list (Bot API's setMyCommands) so
  // Telegram shows suggestions when the user types "/" -- see
  // TelegramCommands.ts for the actual list.
  setMyCommands(commands: readonly BotCommand[]): Promise<void>;
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
  // Phase E: report is exactly what ApplicationService.getSessionStatus()
  // composed -- repository name, ClaudeSessionInfo, derived lifecycleState,
  // and the current task, all already decided upstream.
  formatSessionStatus(report: SessionReport): string;
  // Phase E: repositoryName is exactly what ApplicationService.resetSession()
  // returned -- always a plain confirmation, since resetSession() cannot
  // fail in a user-visible way.
  formatSessionResetResult(repositoryName: string): string;
  // Phase E: outcome is exactly what ApplicationService.stopSession()
  // composed -- every branch of the underlying cancellation (or lack of one)
  // is laid out here, never decided here.
  formatSessionStopResult(outcome: SessionStopOutcome): string;
  // Static command reference text — no input data, unlike every other
  // format* method above. Still lives here, not in TelegramAdapter, so
  // ResponseFormatter stays the single place Telegram-facing text is built.
  formatHelp(): string;
  formatRecommendations(report: RepositoryRecommendationReport): string;
  // Same RepositorySnapshot getRepositoryStatus() already returns for
  // /status — a narrower view over branch/workingTree only.
  formatBranch(snapshot: RepositorySnapshot): string;
  // Same RepositorySnapshot again — a view over branch.current/branches.
  formatBranches(snapshot: RepositorySnapshot): string;
  // Phase A (Task Management): report is exactly what
  // ApplicationService.getCurrentTask() returned -- undefined means no
  // execution is currently tracked for the resolved repository ("Idle"),
  // never a fabricated snapshot standing in for a real one.
  formatCurrentTask(report: CurrentTaskReport | undefined): string;
  // Phase A.2: outcome is exactly what ApplicationService.cancelCurrentTask()
  // returned -- every branch (nothing running, already finished, cancelled,
  // cancelled a pending approval, not cancellable, already cancelling) is
  // laid out here, never decided here.
  formatCancelResult(outcome: TaskCancellationOutcome): string;
  // Phase B: outcome is exactly what ApplicationService.undoLastExecution()
  // returned -- every branch (nothing to undo, execution in progress, drift
  // detected, undone) is laid out here, never decided here.
  formatUndoResult(outcome: UndoOutcome): string;
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
  // Phase C.1: the one place an unexpected (non-CommandParser) error becomes
  // a reply -- removes what used to be the same "Something went wrong: ..."
  // string built inline, three separate times, inside TelegramAdapter.
  formatUnexpectedError(error: unknown): string;
  // Phase C.1: the one place a CommandParser rejection becomes a reply --
  // previously sent to the user as TelegramAdapter's raw error.message, with
  // no consistent styling.
  formatCommandError(message: string): string;
  // Phase C.1: a static literal, moved out of TelegramAdapter so no reply it
  // sends is ever built inline.
  formatUnauthorized(): string;

  // Artifact Management: list/searchArtifacts already return an ArtifactList
  // (summaries only) -- these two render it exactly as returned, never
  // re-sorting or re-filtering.
  formatArtifactList(list: ArtifactList): string;
  formatArtifactSearchResults(query: string, list: ArtifactList): string;
  formatArtifactNotFound(id: string): string;
  // The caption attached to the sendDocument reply "/artifact get <id>"
  // produces -- distinct from every other format* method here, since this
  // one never becomes a standalone sendMessage text.
  formatArtifactCaption(metadata: ArtifactMetadata): string;
  formatArtifactDeleteResult(id: string, existed: boolean): string;
  formatArtifactIndexRebuildResult(result: { before: number; after: number; elapsedMs: number }): string;
}

export interface ITelegramSecurity {
  isAuthorized(userId: number): boolean;
  // Distinct from isAuthorized: gates the destructive/maintenance
  // "/artifact delete" and "/artifact rebuild-index" subcommands to the
  // single configured admin user, on top of (not instead of) the general
  // allowed_users check.
  isAdmin(userId: number): boolean;
}
