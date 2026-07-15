import { randomUUID } from "node:crypto";
import type { IClaudeSessionManager } from "./interfaces";
import type { ClaudeSessionDecision, ClaudeSessionInfo } from "./types";

// Kept internal for now; promote to config/controller.yaml if a future frontend needs it configurable.
const SESSION_IDLE_TIMEOUT_MINUTES = 30;

interface ClaudeSessionRecord {
  id: string;
  repositoryId: string;
  createdAt: Date;
  lastUsedAt: Date;
}

// Pure metadata/policy store: no IClaudeAdapter, no process, no config or
// registry dependency. It decides *whether* the next execution should
// continue or start fresh; the execution layer still constructs its own
// short-lived ClaudeAdapter exactly as it does today.
export class ClaudeSessionManager implements IClaudeSessionManager {
  private readonly sessions = new Map<string, ClaudeSessionRecord>();

  constructor(
    private readonly idleTimeoutMinutes: number = SESSION_IDLE_TIMEOUT_MINUTES,
    private readonly now: () => Date = () => new Date(),
  ) {}

  resolveSession(repositoryId: string, options: { forceNewSession?: boolean } = {}): ClaudeSessionDecision {
    this.dropIfExpired(repositoryId);

    const existing = this.sessions.get(repositoryId);
    const shouldContinue = Boolean(existing) && !options.forceNewSession;

    const record: ClaudeSessionRecord =
      shouldContinue && existing
        ? existing
        : { id: randomUUID(), repositoryId, createdAt: this.now(), lastUsedAt: this.now() };

    record.lastUsedAt = this.now();
    this.sessions.set(repositoryId, record);

    return { session: this.toSessionInfo(record), shouldContinue };
  }

  resetSession(repositoryId: string): void {
    this.sessions.delete(repositoryId);
  }

  expireSession(repositoryId: string): void {
    this.sessions.delete(repositoryId);
  }

  getSessionStatus(repositoryId: string): ClaudeSessionInfo | undefined {
    const record = this.sessions.get(repositoryId);
    return record ? this.toSessionInfo(record) : undefined;
  }

  private dropIfExpired(repositoryId: string): void {
    const record = this.sessions.get(repositoryId);
    if (record && this.isExpired(record)) {
      this.sessions.delete(repositoryId);
    }
  }

  private isExpired(record: ClaudeSessionRecord): boolean {
    const ageMs = this.now().getTime() - record.lastUsedAt.getTime();
    return ageMs > this.idleTimeoutMinutes * 60_000;
  }

  private toSessionInfo(record: ClaudeSessionRecord): ClaudeSessionInfo {
    return {
      id: record.id,
      repositoryId: record.repositoryId,
      status: this.isExpired(record) ? "expired" : "active",
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt,
    };
  }
}
