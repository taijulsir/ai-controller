import { DEFAULT_RUNTIME_POLICY_CONFIG } from "./types";
import type { RuntimePolicyConfig, RuntimePolicyDecision, RuntimePolicyStatus } from "./types";
import type { IRuntimePolicyEngine } from "./interfaces";

// A fixed implementation of the approved runtime-governance rules —
// deliberately not a generic rules engine: no plugins, no DSL, no expression
// parser, no dynamic rule loading. Adding a new governance concept means
// adding a new private check and a new RuntimePolicyDenialReason, not
// extending a configuration format.
//
// Zero dependencies on any other module: only an injectable clock (`now`),
// matching the same pattern already used by ClaudeSessionManager and
// RecommendationStateStore. It never imports monitoring/attention/telegram —
// the dependency arrow only ever points the other way, those modules import
// and call this one.
//
// Cooldown (per repository) and the notification-per-interval limit (GLOBAL)
// are intentionally separate mechanisms, not one generalized "rate limit":
// a repository's own cooldown protects against re-notifying about the same
// repository too often, but does nothing if dozens of unrelated repositories
// all become unhealthy at once — each would still be independently eligible.
// The global limit is what protects the operator from that notification
// storm specifically. Neither can substitute for the other.
//
// This is also a different concern from monitoring's own RecommendationStateStore
// dedup, despite a superficially similar "timestamp map with a threshold"
// shape: RecommendationStateStore asks "has this specific recommendation
// kind's transition already been reported" (content-aware, per
// (repositoryId, recommendationKind)). Cooldown here asks "regardless of
// content, has enough time passed since the last notification for this
// repository" (content-blind, per repositoryId only). Consolidating them
// would conflate two different questions.
export class RuntimePolicyEngine implements IRuntimePolicyEngine {
  private maintenanceMode = false;
  private readonly disabledRepositories = new Set<string>();
  private readonly lastNotifiedAtByRepository = new Map<string, number>();
  private globalNotificationTimestamps: number[] = [];

  constructor(
    private readonly config: RuntimePolicyConfig = DEFAULT_RUNTIME_POLICY_CONFIG,
    private readonly now: () => Date = () => new Date(),
  ) {}

  evaluateMonitoring(repositoryId: string): RuntimePolicyDecision {
    if (this.isQuietHours()) {
      return { allowed: false, reason: "quiet-hours" };
    }
    if (this.maintenanceMode) {
      return { allowed: false, reason: "maintenance-mode" };
    }
    if (this.disabledRepositories.has(repositoryId)) {
      return { allowed: false, reason: "repository-disabled" };
    }
    return { allowed: true };
  }

  evaluateNotification(repositoryId: string): RuntimePolicyDecision {
    if (this.isQuietHours()) {
      return { allowed: false, reason: "quiet-hours" };
    }
    if (this.maintenanceMode) {
      return { allowed: false, reason: "maintenance-mode" };
    }
    if (this.isCooldownActive(repositoryId)) {
      return { allowed: false, reason: "cooldown" };
    }
    if (this.isOverGlobalNotificationLimit()) {
      return { allowed: false, reason: "notification-limit" };
    }
    return { allowed: true };
  }

  recordNotificationSent(repositoryId: string): void {
    const nowMs = this.now().getTime();
    this.lastNotifiedAtByRepository.set(repositoryId, nowMs);
    this.globalNotificationTimestamps.push(nowMs);
  }

  setMaintenanceMode(enabled: boolean): void {
    this.maintenanceMode = enabled;
  }

  setRepositoryMonitoringEnabled(repositoryId: string, enabled: boolean): void {
    if (enabled) {
      this.disabledRepositories.delete(repositoryId);
    } else {
      this.disabledRepositories.add(repositoryId);
    }
  }

  // Read-only: every field below is produced by calling the exact same
  // private checks evaluateMonitoring()/evaluateNotification() already use
  // (isQuietHours(), isCooldownActive(), the shared pruning helper) — never a
  // second, separately-derived copy of that logic, and never a mutation.
  getStatus(): RuntimePolicyStatus {
    const repositoriesInCooldown = [...this.lastNotifiedAtByRepository.keys()].filter((repositoryId) =>
      this.isCooldownActive(repositoryId),
    ).length;

    return {
      maintenanceMode: this.maintenanceMode,
      quietHoursActive: this.isQuietHours(),
      repositoriesDisabled: this.disabledRepositories.size,
      repositoriesInCooldown,
      globalNotificationBudget: {
        used: this.pruneAndCountGlobalNotifications(),
        max: this.config.maxNotificationsPerInterval,
        windowMs: this.config.notificationIntervalMs,
      },
    };
  }

  private isQuietHours(): boolean {
    const { startHour, endHour } = this.config.quietHours;
    if (startHour === endHour) {
      return false;
    }
    const hour = this.now().getHours();
    return startHour < endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
  }

  private isCooldownActive(repositoryId: string): boolean {
    const lastNotifiedAt = this.lastNotifiedAtByRepository.get(repositoryId);
    if (lastNotifiedAt === undefined) {
      return false;
    }
    return this.now().getTime() - lastNotifiedAt < this.config.cooldownMs;
  }

  private isOverGlobalNotificationLimit(): boolean {
    return this.pruneAndCountGlobalNotifications() >= this.config.maxNotificationsPerInterval;
  }

  // Prunes expired entries as a side effect of checking — same "lazy cleanup
  // on read" precedent RecommendationStateStore already established. Shared
  // by isOverGlobalNotificationLimit() and getStatus() so the count reported
  // by one is never allowed to drift from what the other actually enforces —
  // there is exactly one place this window is computed.
  private pruneAndCountGlobalNotifications(): number {
    const nowMs = this.now().getTime();
    const windowStart = nowMs - this.config.notificationIntervalMs;
    this.globalNotificationTimestamps = this.globalNotificationTimestamps.filter((timestamp) => timestamp > windowStart);
    return this.globalNotificationTimestamps.length;
  }
}
