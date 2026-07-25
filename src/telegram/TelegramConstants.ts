export const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
export const LONG_POLL_TIMEOUT_SECONDS = 30;
export const POLL_ERROR_BACKOFF_MS = 2000;

// Kept internal for now; promote to a config/controller.yaml `approval.timeout_minutes`
// field later if this ever needs to be configurable.
export const APPROVAL_TIMEOUT_MINUTES = 15;

// Telegram's hard limit is 4096 UTF-16 code units per text message. This
// leaves a safety margin below that for multi-byte characters, so a message
// right at the boundary never trips the API's exact cutoff.
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4000;

// Git History & Inspection System (/history): a per-message inline keyboard
// grows by one row (3 buttons) per commit shown -- uncapped, a full
// MAX_HISTORY_LIMIT (50) response would attach 150 buttons to a single
// message, which is unusable as a keyboard even though the text itself
// still renders fine (and still gets its own, separate split via
// splitMessageText if it's long). Capped independently of the display
// count so every commit stays visible and addressable via /show, /diff,
// /undo <hash> -- only how many of them get a *button row* is bounded.
export const MAX_HISTORY_KEYBOARD_ITEMS = 10;

export function buildTelegramApiUrl(token: string, method: string): string {
  return `${TELEGRAM_API_BASE_URL}/bot${token}/${method}`;
}
