import type { ClaudeSessionDecision, ClaudeSessionInfo } from "./types";

export interface IClaudeSessionManager {
  resolveSession(repositoryId: string, options?: { forceNewSession?: boolean }): ClaudeSessionDecision;
  resetSession(repositoryId: string): void;
  expireSession(repositoryId: string): void;
  getSessionStatus(repositoryId: string): ClaudeSessionInfo | undefined;
}
