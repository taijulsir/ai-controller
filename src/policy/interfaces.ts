import type { RuntimePolicyDecision, RuntimePolicyStatus } from "./types";

// Deliberately transport-agnostic and side-effect-narrow: this contract knows
// nothing about Telegram, Slack, Discord, or any other attention transport,
// nothing about monitoring/recommendation logic, and never executes a
// Task/workflow or reaches ControllerCore/ExecutionPipeline — it has no
// dependency capable of any of that. It only ever answers "allowed?" and
// "why not?", plus the small set of mutations needed to change what it will
// answer next time.
export interface IRuntimePolicyEngine {
  // Repository still exists per IRepositoryRegistry — this only answers
  // whether policy currently permits evaluating it.
  evaluateMonitoring(repositoryId: string): RuntimePolicyDecision;

  // Answers whether a notification for this repository may be delivered
  // right now — independent of, and checked separately from,
  // evaluateMonitoring().
  evaluateNotification(repositoryId: string): RuntimePolicyDecision;

  // Called once a delivery attempt has actually been made (regardless of
  // whether every transport succeeded) — starts this repository's cooldown
  // and counts toward the global notification-per-interval limit.
  recordNotificationSent(repositoryId: string): void;

  setMaintenanceMode(enabled: boolean): void;

  // Single intent-based API replacing separate enable/disable methods — the
  // caller states the desired end state, not which direction to move.
  setRepositoryMonitoringEnabled(repositoryId: string, enabled: boolean): void;

  // Read-only (Phase 8.5): reports state already held for evaluateMonitoring()/
  // evaluateNotification()'s own decisions — never itself a decision, never
  // changes what either method will answer next time it's called.
  getStatus(): RuntimePolicyStatus;
}
