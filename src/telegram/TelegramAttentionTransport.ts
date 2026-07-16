import type { IAttentionTransport } from "../attention/interfaces";
import type { IConfigService } from "../config/interfaces";
import type { AttentionEvent } from "../monitoring/types";
import { NoNotificationRecipientConfiguredError } from "./errors";
import type { ITelegramClient } from "./interfaces";

// Telegram's implementation of IAttentionTransport — the only seam this
// module plugs into. TelegramAdapter/CommandParser/ResponseFormatter are not
// touched: this class depends only on ITelegramClient and IConfigService,
// exactly like every other Telegram collaborator, and has no relationship to
// existing command handling.
//
// Reuses the existing operator configuration (security.allowed_users) as the
// notification destination rather than introducing new configuration — the
// first configured allowed user is treated as the personal operator chat,
// consistent with this project's single-operator framing (Phase 8.3
// deliberately introduces no new config).
export class TelegramAttentionTransport implements IAttentionTransport {
  constructor(
    private readonly telegramClient: ITelegramClient,
    private readonly configService: IConfigService,
  ) {}

  async deliver(events: AttentionEvent[]): Promise<void> {
    const chatId = this.resolveChatId();
    await this.telegramClient.sendMessage({ chatId, text: this.formatEvents(events) });
  }

  private resolveChatId(): number {
    const { security } = this.configService.getTelegramConfig();
    const [firstAllowedUser] = security.allowed_users;
    if (!firstAllowedUser) {
      throw new NoNotificationRecipientConfiguredError();
    }
    return Number(firstAllowedUser);
  }

  private formatEvents(events: AttentionEvent[]): string {
    return [`Attention needed (${events.length}):`, ...events.map((event) => this.formatEvent(event))].join("\n");
  }

  private formatEvent(event: AttentionEvent): string {
    const icon = event.priority === "critical" ? "🔴" : event.priority === "high" ? "⚠" : "ℹ";
    return `${icon} [${event.repositoryId}] ${event.reason}`;
  }
}
