export const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
export const LONG_POLL_TIMEOUT_SECONDS = 30;
export const POLL_ERROR_BACKOFF_MS = 2000;

// Kept internal for now; promote to a config/controller.yaml `approval.timeout_minutes`
// field later if this ever needs to be configurable.
export const APPROVAL_TIMEOUT_MINUTES = 15;

export function buildTelegramApiUrl(token: string, method: string): string {
  return `${TELEGRAM_API_BASE_URL}/bot${token}/${method}`;
}
