import type { InlineKeyboardButton } from "./types";

export function buildApprovalKeyboard(correlationId: string): InlineKeyboardButton[][] {
  return [
    [
      { text: "✅ Approve", callbackData: `approval:approve:${correlationId}` },
      { text: "❌ Reject", callbackData: `approval:reject:${correlationId}` },
    ],
  ];
}

// Git History & Inspection System: one row of three buttons per commit
// shown by /history -- callback_data carries the repository id and short
// hash (never the correlationId shape above, which needs "everything after
// the second colon" parsing; neither a repository id nor a git short hash
// can ever contain a colon, so a plain split is always safe here -- see
// TelegramAdapter.handleCallback's own doc comment). The "history:" prefix
// is shared across all three actions so a future action (cherry-pick,
// checkout, blame, revert, tag, compare) is just one more button in the
// same row, matched by the same handler via one more action-name branch --
// never a new prefix, a new keyboard-building function, or a new
// ITelegramCallbackHandler.
export function buildGitHistoryItemKeyboard(repositoryId: string, shortSha: string): InlineKeyboardButton[][] {
  return [
    [
      { text: "👁 Show", callbackData: `history:show:${repositoryId}:${shortSha}` },
      { text: "📊 Diff", callbackData: `history:diff:${repositoryId}:${shortSha}` },
      { text: "↩ Undo", callbackData: `history:undo:${repositoryId}:${shortSha}` },
    ],
  ];
}
