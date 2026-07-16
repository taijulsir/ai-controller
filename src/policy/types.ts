// Why a decision denied, never invented by the caller — MonitoringWorker and
// AttentionDispatcher consume this value directly, they never derive their
// own explanation for a denial.
export type RuntimePolicyDenialReason =
  | "quiet-hours"
  | "maintenance-mode"
  | "repository-disabled"
  | "cooldown"
  | "notification-limit";

export interface RuntimePolicyDecision {
  allowed: boolean;
  reason?: RuntimePolicyDenialReason;
}

// [startHour, endHour) in server-local 24h time, wrapping past midnight when
// startHour > endHour (e.g. 22 -> 7 means 22:00-23:59 and 00:00-06:59).
export interface QuietHoursConfig {
  startHour: number;
  endHour: number;
}

// Kept internal for now, same "kept internal for now" precedent already
// established by DecisionEngine's thresholds and monitoring's own
// MonitoringPolicy/DEFAULT_MONITORING_POLICY — no YAML, no dynamic reload.
// Promote to config only if a future phase genuinely needs these tunable.
export interface RuntimePolicyConfig {
  quietHours: QuietHoursConfig;
  // Per-repository: how long after a notification for a given repository
  // before another one is allowed for that same repository. Deliberately
  // separate from the global limit below — see RuntimePolicyEngine's own
  // doc comment for why these are two different concepts, not duplicates of
  // each other.
  cooldownMs: number;
  // GLOBAL, not per-repository: caps how many notifications may be sent
  // across ALL repositories within notificationIntervalMs. If dozens of
  // repositories become unhealthy at once, this is what protects the
  // operator from a notification storm — per-repository cooldown alone
  // would not, since each repository would still be independently eligible.
  maxNotificationsPerInterval: number;
  notificationIntervalMs: number;
}

export const DEFAULT_RUNTIME_POLICY_CONFIG: RuntimePolicyConfig = {
  quietHours: { startHour: 22, endHour: 7 },
  cooldownMs: 30 * 60 * 1000, // 30 minutes per repository
  maxNotificationsPerInterval: 5, // global
  notificationIntervalMs: 60 * 60 * 1000, // 1 hour window
};

// Read-only observation of already-held state — every field here is derived
// by reusing RuntimePolicyEngine's own existing decision logic (isQuietHours(),
// isCooldownActive(), the same pruning isOverGlobalNotificationLimit() already
// performs), never a second, separately-maintained copy of it.
export interface RuntimePolicyStatus {
  maintenanceMode: boolean;
  quietHoursActive: boolean;
  repositoriesDisabled: number;
  repositoriesInCooldown: number;
  globalNotificationBudget: { used: number; max: number; windowMs: number };
}
