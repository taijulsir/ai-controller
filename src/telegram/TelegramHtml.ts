// The one shared escaping helper for Telegram's HTML parse_mode (see
// TelegramApiClient's own doc comment for why HTML mode was chosen over
// MarkdownV2). Telegram's HTML mode only requires escaping these three
// characters -- anything else is passed through untouched. Used by
// ResponseFormatter (for every externally-sourced value it interpolates) and
// by the two other places in this module that build message text outside
// ResponseFormatter (TelegramApprovalProvider's approval prompt,
// TelegramAttentionTransport's event notifications) -- one implementation,
// not three, now that every sendMessage() call is interpreted as HTML.
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
