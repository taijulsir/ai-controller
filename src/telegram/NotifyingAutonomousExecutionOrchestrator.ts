import type { IAutonomousExecutionOrchestrator } from "../autonomousexecution/interfaces";
import type { PipelineResult } from "../pipeline/types";
import type { IResponseFormatter, ITelegramClient } from "./interfaces";

// Phase 15: the same decorator shape ApprovalEngine and
// MemoryRecordingControllerCore already use for IControllerCore, applied to
// IAutonomousExecutionOrchestrator instead — wrap the real implementation to
// add one cross-cutting concern (telling the operator what happened),
// without AutonomousExecutionOrchestrator or AutonomousExecutionWorker ever
// changing. Lives here, in src/telegram/, the same place
// TelegramAttentionTransport (a Telegram-specific implementation of the
// domain-neutral IAttentionTransport) already lives — never in
// src/autonomousexecution/, which stays entirely unaware this class exists.
//
// Forwards every call to the wrapped orchestrator unchanged and returns its
// exact, unmodified PipelineResult — this class never alters what the
// caller (AutonomousExecutionWorker) sees. It only notifies when a real
// attempt was actually made (result !== undefined); "nothing eligible this
// cycle" produces no message, so an hourly no-op tick never becomes hourly
// operator noise. A failed notification is caught and logged, exactly like
// MemoryRecordingControllerCore's own recordSafely() — it can never affect
// the result already being returned to the caller.
export class NotifyingAutonomousExecutionOrchestrator implements IAutonomousExecutionOrchestrator {
  constructor(
    private readonly inner: IAutonomousExecutionOrchestrator,
    private readonly telegramClient: ITelegramClient,
    private readonly responseFormatter: IResponseFormatter,
    private readonly chatId: number,
  ) {}

  async attemptExecution(correlationId?: string): Promise<PipelineResult | undefined> {
    const result = await this.inner.attemptExecution(correlationId);
    if (result) {
      await this.notifySafely(result);
    }
    return result;
  }

  private async notifySafely(result: PipelineResult): Promise<void> {
    try {
      await this.telegramClient.sendMessage({
        chatId: this.chatId,
        text: this.responseFormatter.formatAutonomousExecutionResult(result),
      });
    } catch (error) {
      console.error(
        "notifying-autonomous-execution-orchestrator: failed to send notification:",
        error instanceof Error ? error.message : error,
      );
    }
  }
}
