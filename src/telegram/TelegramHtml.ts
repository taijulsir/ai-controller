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

// Defense-in-depth counterpart to escapeHtml: strips this module's own tags
// (b, code, pre -- the only ones ResponseFormatter ever emits) and decodes
// entities back to plain characters, in the reverse order escapeHtml applies
// them. Used by TelegramApiClient as a last-resort plain-text fallback when
// Telegram rejects a message's HTML outright (e.g. a future formatting bug
// produces unbalanced tags) -- so a user gets a readable, if unstyled,
// message instead of a silent 400.
export function stripHtml(text: string): string {
  return text
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
