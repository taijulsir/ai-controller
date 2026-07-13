export const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
export const LONG_POLL_TIMEOUT_SECONDS = 30;
export const POLL_ERROR_BACKOFF_MS = 2000;

export function buildTelegramApiUrl(token: string, method: string): string {
  return `${TELEGRAM_API_BASE_URL}/bot${token}/${method}`;
}
