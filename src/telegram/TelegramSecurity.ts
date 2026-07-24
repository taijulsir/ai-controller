import type { IConfigService } from "../config/interfaces";
import type { ITelegramSecurity } from "./interfaces";

export class TelegramSecurity implements ITelegramSecurity {
  constructor(private readonly configService: IConfigService) {}

  isAuthorized(userId: number): boolean {
    const { security } = this.configService.getTelegramConfig();
    return security.allowed_users.includes(String(userId));
  }

  isAdmin(userId: number): boolean {
    const { security } = this.configService.getTelegramConfig();
    return security.admin_user_id !== undefined && security.admin_user_id === String(userId);
  }
}
