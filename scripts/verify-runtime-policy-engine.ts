import { RuntimePolicyEngine } from "../src/policy/RuntimePolicyEngine";
import type { RuntimePolicyConfig } from "../src/policy/types";

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

class Clock {
  private current: Date;
  constructor(start: Date) {
    this.current = start;
  }
  now = (): Date => this.current;
  setHour(hour: number): void {
    this.current = new Date(this.current.getFullYear(), this.current.getMonth(), this.current.getDate(), hour, 0, 0);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

const baseConfig: RuntimePolicyConfig = {
  quietHours: { startHour: 22, endHour: 7 },
  cooldownMs: 10_000,
  maxNotificationsPerInterval: 3,
  notificationIntervalMs: 60_000,
};

function nonQuietConfig(overrides: Partial<RuntimePolicyConfig> = {}): RuntimePolicyConfig {
  // startHour === endHour is the documented degenerate "no quiet hours" case.
  return { ...baseConfig, quietHours: { startHour: 0, endHour: 0 }, ...overrides };
}

async function main(): Promise<void> {
  // Quiet hours: wrapping range (22 -> 7) correctly covers both sides of midnight.
  {
    const clock = new Clock(new Date(2026, 0, 1, 12, 0, 0));
    const engine = new RuntimePolicyEngine(baseConfig, clock.now);

    clock.setHour(23);
    assert(engine.evaluateMonitoring("alpha").reason === "quiet-hours", "23:00 falls inside a 22->7 quiet-hours window");

    clock.setHour(3);
    assert(engine.evaluateMonitoring("alpha").reason === "quiet-hours", "03:00 falls inside a 22->7 quiet-hours window (past midnight)");

    clock.setHour(12);
    const decision = engine.evaluateMonitoring("alpha");
    assert(decision.allowed === true && decision.reason === undefined, "12:00 falls outside a 22->7 quiet-hours window, and an allowed decision carries no reason");

    clock.setHour(22);
    assert(engine.evaluateMonitoring("alpha").reason === "quiet-hours", "the window's start hour (22) is inclusive");

    clock.setHour(7);
    assert(engine.evaluateMonitoring("alpha").allowed === true, "the window's end hour (7) is exclusive — quiet hours have ended");
  }

  // Maintenance mode suppresses both monitoring and notification, everywhere,
  // until explicitly turned off again.
  {
    const clock = new Clock(new Date(2026, 0, 1, 12, 0, 0));
    const engine = new RuntimePolicyEngine(nonQuietConfig(), clock.now);

    assert(engine.evaluateMonitoring("alpha").allowed === true, "monitoring allowed before maintenance mode is enabled");

    engine.setMaintenanceMode(true);
    assert(engine.evaluateMonitoring("alpha").reason === "maintenance-mode", "evaluateMonitoring() is denied with reason 'maintenance-mode' once enabled");
    assert(engine.evaluateNotification("alpha").reason === "maintenance-mode", "evaluateNotification() is denied with reason 'maintenance-mode' too");

    engine.setMaintenanceMode(false);
    assert(engine.evaluateMonitoring("alpha").allowed === true, "monitoring is allowed again once maintenance mode is turned back off");
  }

  // Repository-level enable/disable via the single intent-based API affects
  // only the targeted repository, and only evaluateMonitoring — not
  // evaluateNotification (per-repository disablement is a monitoring-time
  // concept; the reason "repository-disabled" is documented for monitoring).
  {
    const clock = new Clock(new Date(2026, 0, 1, 12, 0, 0));
    const engine = new RuntimePolicyEngine(nonQuietConfig(), clock.now);

    engine.setRepositoryMonitoringEnabled("alpha", false);
    assert(engine.evaluateMonitoring("alpha").reason === "repository-disabled", "a disabled repository is denied with reason 'repository-disabled'");
    assert(engine.evaluateMonitoring("beta").allowed === true, "a sibling repository is unaffected by another repository's disablement");

    engine.setRepositoryMonitoringEnabled("alpha", true);
    assert(engine.evaluateMonitoring("alpha").allowed === true, "re-enabling via setRepositoryMonitoringEnabled(id, true) restores monitoring for that repository");
  }

  // Cooldown is per repository: notifying about one repository does not
  // start a cooldown for a different repository.
  {
    const clock = new Clock(new Date(2026, 0, 1, 12, 0, 0));
    const engine = new RuntimePolicyEngine(nonQuietConfig(), clock.now);

    assert(engine.evaluateNotification("alpha").allowed === true, "notification allowed before any prior notification for this repository");

    engine.recordNotificationSent("alpha");
    assert(engine.evaluateNotification("alpha").reason === "cooldown", "immediately after recordNotificationSent(), the same repository is in cooldown");
    assert(engine.evaluateNotification("beta").allowed === true, "cooldown for 'alpha' does not affect 'beta'");

    clock.advance(10_000);
    assert(engine.evaluateNotification("alpha").allowed === true, "once cooldownMs has elapsed, the repository is eligible again");
  }

  // Global notification limit: distinct from cooldown, and enforced across
  // repositories, not per repository — this is what protects against a
  // notification storm when many repositories become unhealthy at once.
  {
    const clock = new Clock(new Date(2026, 0, 1, 12, 0, 0));
    // Cooldown of 0 isolates this test to the global limit only.
    const engine = new RuntimePolicyEngine(nonQuietConfig({ cooldownMs: 0, maxNotificationsPerInterval: 3 }), clock.now);

    engine.recordNotificationSent("alpha");
    clock.advance(1);
    engine.recordNotificationSent("beta");
    clock.advance(1);
    engine.recordNotificationSent("gamma");
    clock.advance(1);

    const decision = engine.evaluateNotification("delta");
    assert(
      decision.reason === "notification-limit",
      "a 4th distinct repository is denied with reason 'notification-limit' once the GLOBAL cap (3) is reached, even though 'delta' itself was never notified before",
    );

    clock.advance(60_000); // past the 1-minute global interval window
    assert(engine.evaluateNotification("delta").allowed === true, "once the global interval window has fully elapsed, notifications are allowed again");
  }

  // Cooldown and the global limit are independent mechanisms: raising one
  // does not silently satisfy the other.
  {
    const clock = new Clock(new Date(2026, 0, 1, 12, 0, 0));
    const engine = new RuntimePolicyEngine(nonQuietConfig({ cooldownMs: 999_999, maxNotificationsPerInterval: 100 }), clock.now);

    engine.recordNotificationSent("alpha");
    const decision = engine.evaluateNotification("alpha");
    assert(
      decision.reason === "cooldown",
      "a repository still inside its own long cooldown is denied with reason 'cooldown' even though the (generously high) global limit has not been reached",
    );
  }

  // A decision object, not a bare boolean — and an allowed decision never
  // carries a reason.
  {
    const clock = new Clock(new Date(2026, 0, 1, 12, 0, 0));
    const engine = new RuntimePolicyEngine(nonQuietConfig(), clock.now);
    const decision = engine.evaluateMonitoring("alpha");
    assert(typeof decision === "object" && typeof decision.allowed === "boolean", "evaluateMonitoring() returns a RuntimePolicyDecision object, not a boolean");
    assert(decision.reason === undefined, "an allowed decision carries no reason");
  }

  // Phase 8.5: getStatus() reflects maintenance mode and quiet-hours-active
  // by reusing the exact same checks evaluateMonitoring()/evaluateNotification()
  // already use — not a second, independently-derived answer.
  {
    const clock = new Clock(new Date(2026, 0, 1, 12, 0, 0));
    const engine = new RuntimePolicyEngine(baseConfig, clock.now);

    clock.setHour(12);
    assert(engine.getStatus().quietHoursActive === false, "getStatus() reports quietHoursActive: false outside the configured window");
    clock.setHour(23);
    assert(engine.getStatus().quietHoursActive === true, "getStatus() reports quietHoursActive: true inside the configured window");

    clock.setHour(12);
    assert(engine.getStatus().maintenanceMode === false, "getStatus() reports maintenanceMode: false by default");
    engine.setMaintenanceMode(true);
    assert(engine.getStatus().maintenanceMode === true, "getStatus() reports maintenanceMode: true once enabled");
  }

  // Phase 8.5: getStatus() reports how many repositories are currently
  // disabled and how many are currently in cooldown — counts, derived from
  // the same state setRepositoryMonitoringEnabled()/recordNotificationSent()
  // already maintain.
  {
    const clock = new Clock(new Date(2026, 0, 1, 12, 0, 0));
    const engine = new RuntimePolicyEngine(nonQuietConfig(), clock.now);

    assert(engine.getStatus().repositoriesDisabled === 0, "getStatus() reports 0 disabled repositories by default");
    engine.setRepositoryMonitoringEnabled("alpha", false);
    engine.setRepositoryMonitoringEnabled("beta", false);
    assert(engine.getStatus().repositoriesDisabled === 2, "getStatus() counts every currently-disabled repository");
    engine.setRepositoryMonitoringEnabled("alpha", true);
    assert(engine.getStatus().repositoriesDisabled === 1, "getStatus() reflects a repository being re-enabled");

    assert(engine.getStatus().repositoriesInCooldown === 0, "getStatus() reports 0 repositories in cooldown by default");
    engine.recordNotificationSent("gamma");
    assert(engine.getStatus().repositoriesInCooldown === 1, "getStatus() counts a repository currently within its own cooldown");
    clock.advance(10_000); // past cooldownMs
    assert(engine.getStatus().repositoriesInCooldown === 0, "getStatus() no longer counts a repository once its cooldown has elapsed");
  }

  // Phase 8.5: getStatus()'s global notification budget is pruned the same
  // way isOverGlobalNotificationLimit() prunes — calling getStatus() alone,
  // with no prior evaluateNotification() call, must not report a stale,
  // un-pruned count.
  {
    const clock = new Clock(new Date(2026, 0, 1, 12, 0, 0));
    const engine = new RuntimePolicyEngine(nonQuietConfig({ cooldownMs: 0, maxNotificationsPerInterval: 3, notificationIntervalMs: 60_000 }), clock.now);

    assert(
      engine.getStatus().globalNotificationBudget.used === 0 && engine.getStatus().globalNotificationBudget.max === 3,
      "getStatus() reports the configured global budget before any notification has been sent",
    );

    engine.recordNotificationSent("alpha");
    engine.recordNotificationSent("beta");
    assert(engine.getStatus().globalNotificationBudget.used === 2, "getStatus() reports the number of notifications currently counted within the window");

    clock.advance(60_000); // past notificationIntervalMs
    assert(
      engine.getStatus().globalNotificationBudget.used === 0,
      "getStatus() prunes expired entries itself — calling getStatus() alone, with no intervening evaluateNotification() call, still reports an accurate (not stale) used count",
    );
  }
}

main();
