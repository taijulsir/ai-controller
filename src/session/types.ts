export interface ClaudeSessionInfo {
  id: string;
  repositoryId: string;
  status: "active" | "expired";
  createdAt: Date;
  lastUsedAt: Date;
}

export interface ClaudeSessionDecision {
  session: ClaudeSessionInfo;
  shouldContinue: boolean;
}
