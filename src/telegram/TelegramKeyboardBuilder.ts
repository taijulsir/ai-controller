import type { InlineKeyboardButton } from "./types";

export function buildApprovalKeyboard(correlationId: string): InlineKeyboardButton[][] {
  return [
    [
      { text: "✅ Approve", callbackData: `approval:approve:${correlationId}` },
      { text: "❌ Reject", callbackData: `approval:reject:${correlationId}` },
    ],
  ];
}
