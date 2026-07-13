const CORRELATION_PATTERN = /^telegram:(-?\d+):(\d+)$/;

export function buildTelegramCorrelationId(chatId: number, updateId: number): string {
  return `telegram:${chatId}:${updateId}`;
}

export function parseTelegramCorrelationId(correlationId: string): { chatId: number; updateId: number } | undefined {
  const match = correlationId.match(CORRELATION_PATTERN);
  if (!match) return undefined;
  return { chatId: Number(match[1]), updateId: Number(match[2]) };
}
