import type { ClaudeSessionDecision, ClaudeSessionInfo } from "./types";

export interface IClaudeSessionManager {
  resolveSession(repositoryId: string, options?: { forceNewSession?: boolean }): ClaudeSessionDecision;
  resetSession(repositoryId: string): void;
  getSessionStatus(repositoryId: string): ClaudeSessionInfo | undefined;
  // Phase E: exposes the already-existing internal idle timeout (previously
  // a private constant with no external reader) so ApplicationService/
  // ResponseFormatter can compute "expires in" without hardcoding a second,
  // independent copy of the same threshold.
  getIdleTimeoutMinutes(): number;
}
