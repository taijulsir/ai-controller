import type { IApprovalProvider } from "../approval/interfaces";
import type { ApprovalDecision, ApprovalRequest } from "../approval/types";
import { APPROVAL_TIMEOUT_MINUTES } from "./TelegramConstants";
import { parseTelegramCorrelationId } from "./TelegramCorrelation";
import { buildApprovalKeyboard } from "./TelegramKeyboardBuilder";
import { describeError, logEvent } from "./TelegramLogger";
import type { ITelegramCallbackHandler, ITelegramClient, ITelegramSecurity } from "./interfaces";
import type { TelegramCallbackQuery } from "./types";

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timeout: NodeJS.Timeout;
}

// Pending approvals live only in this process's memory: a controller restart
// loses any request that hasn't been approved/rejected yet (the requester's
// original task call will still be awaiting a promise that never resolves,
// until the timeout below fires it against a now-empty map).
export class TelegramApprovalProvider implements IApprovalProvider, ITelegramCallbackHandler {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly telegramClient: ITelegramClient,
    private readonly telegramSecurity: ITelegramSecurity,
  ) {}

  async requestApproval(request: ApprovalRequest): Promise<ApprovalDecision> {
    const target = parseTelegramCorrelationId(request.correlationId);
    if (!target) {
      return {
        approved: false,
        reason: "Cannot request Telegram approval: correlationId was not created by the Telegram transport.",
      };
    }

    return new Promise<ApprovalDecision>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.correlationId);
        logEvent("warn", "telegram.approval.timed_out", { correlationId: request.correlationId });
        resolve({ approved: false, reason: `Approval request timed out after ${APPROVAL_TIMEOUT_MINUTES} minute(s).` });
      }, APPROVAL_TIMEOUT_MINUTES * 60_000);

      this.pending.set(request.correlationId, { resolve, timeout });

      this.telegramClient
        .sendMessage({
          chatId: target.chatId,
          text: this.buildPromptText(request),
          inlineKeyboard: buildApprovalKeyboard(request.correlationId),
        })
        .then(() => {
          logEvent("info", "telegram.approval.requested", { correlationId: request.correlationId, chatId: target.chatId });
        })
        .catch((error) => {
          logEvent("error", "telegram.approval.send_failed", { correlationId: request.correlationId, error: describeError(error) });
          this.settle(request.correlationId, {
            approved: false,
            reason: "Failed to send the Telegram approval prompt.",
          });
        });
    });
  }

  async handleCallback(callbackQuery: TelegramCallbackQuery): Promise<void> {
    // correlationId itself contains colons (see TelegramCorrelation.ts), so it
    // must be captured as everything after the second colon, not split on ":".
    const match = callbackQuery.data.match(/^approval:(approve|reject):(.+)$/);
    if (!match) {
      return;
    }
    const [, action, correlationId] = match;

    if (!this.telegramSecurity.isAuthorized(callbackQuery.userId)) {
      await this.telegramClient.answerCallbackQuery(callbackQuery.id, "You are not authorized to approve this.");
      logEvent("warn", "telegram.approval.unauthorized_attempt", { correlationId, userId: callbackQuery.userId });
      return;
    }

    if (!this.pending.has(correlationId)) {
      await this.telegramClient.answerCallbackQuery(callbackQuery.id, "This request is no longer awaiting approval.");
      return;
    }

    const approved = action === "approve";
    this.settle(correlationId, approved
      ? { approved: true, approvedBy: String(callbackQuery.userId) }
      : { approved: false, reason: `Rejected by Telegram user ${callbackQuery.userId}.` });

    await this.telegramClient.answerCallbackQuery(callbackQuery.id, approved ? "Approved ✅" : "Rejected ❌");
    await this.telegramClient.sendMessage({
      chatId: callbackQuery.chatId,
      text: approved ? "✅ Approved. Proceeding..." : "❌ Rejected. The task will not proceed.",
    });
    logEvent("info", "telegram.approval.decided", { correlationId, action, userId: callbackQuery.userId });
  }

  private settle(correlationId: string, decision: ApprovalDecision): void {
    const pending = this.pending.get(correlationId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(correlationId);
    pending.resolve(decision);
  }

  private buildPromptText(request: ApprovalRequest): string {
    const repoSuffix = request.repositoryId ? ` in repository "${request.repositoryId}"` : "";
    return `Approval required: "${request.task.type}"${repoSuffix}.\n\nApprove or reject?`;
  }
}
