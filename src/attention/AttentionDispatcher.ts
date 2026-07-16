import type { AttentionEvent } from "../monitoring/types";
import type { IRuntimePolicyEngine } from "../policy/interfaces";
import type { IAttentionDispatcher, IAttentionTransport } from "./interfaces";
import type { AttentionDispatcherStatus } from "./types";

// Intentionally small: registered transports are fixed after construction
// only via addTransport() (never removed), and dispatch() does exactly one
// thing per repository — ask RuntimePolicy, then (if allowed) fan the
// group's events out to each registered transport, isolating one transport's
// failure from another, then report the attempt back to RuntimePolicy. No
// retry, no batching, no queue, no persistence, no additional deduplication
// belongs here; each of those is a deliberate exclusion, not an oversight.
// Grouping events by repositoryId (rather than assuming a batch is already
// scoped to one repository) is a defensive, future-proofing step: nothing in
// AttentionEvent[]'s type guarantees single-repository scope, and evaluating
// policy per group is what makes that guarantee unnecessary. No policy logic
// of any kind lives here — every decision and its reason come from
// IRuntimePolicyEngine, consumed directly, never re-derived.
//
// addTransport() exists (rather than a constructor-only list) because the
// composition root builds this dispatcher before it knows whether Telegram
// will be enabled — MonitoringWorker needs a dispatcher instance to depend on
// immediately, while a concrete transport can only be registered once
// Telegram's own collaborators exist, later and conditionally.
export class AttentionDispatcher implements IAttentionDispatcher {
  private readonly transports: IAttentionTransport[] = [];
  // Phase 8.5: additive bookkeeping only, updated inside dispatch()/
  // dispatchForRepository()'s existing control flow — no change to what
  // either method does or returns.
  private lastDispatchAt?: Date;
  private notificationsDelivered = 0;
  private notificationsSuppressed = 0;

  constructor(private readonly runtimePolicy: IRuntimePolicyEngine) {}

  addTransport(transport: IAttentionTransport): void {
    this.transports.push(transport);
  }

  async dispatch(events: AttentionEvent[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    this.lastDispatchAt = new Date();
    for (const [repositoryId, repositoryEvents] of this.groupByRepository(events)) {
      await this.dispatchForRepository(repositoryId, repositoryEvents);
    }
  }

  private async dispatchForRepository(repositoryId: string, events: AttentionEvent[]): Promise<void> {
    if (this.transports.length === 0) {
      return;
    }

    const decision = this.runtimePolicy.evaluateNotification(repositoryId);
    if (!decision.allowed) {
      this.notificationsSuppressed += 1;
      console.log(`attention-dispatcher: notification suppressed for ${repositoryId} (${decision.reason})`);
      return;
    }

    for (const transport of this.transports) {
      try {
        await transport.deliver(events);
      } catch (error) {
        console.error(
          "attention-dispatcher: transport delivery failed:",
          error instanceof Error ? error.message : error,
        );
      }
    }

    // Recorded once per repository group, after attempting delivery to every
    // registered transport, regardless of individual transport success or
    // failure — cooldown/rate-limit tracks that a delivery attempt was made,
    // not that every transport succeeded, so a persistently-failing
    // transport can never defeat rate-limiting by silently never starting
    // the cooldown.
    this.runtimePolicy.recordNotificationSent(repositoryId);
    this.notificationsDelivered += 1;
  }

  // Read-only: reports counters already tracked above, never triggers a
  // dispatch or delivery attempt as a side effect of being asked.
  getStatus(): AttentionDispatcherStatus {
    return {
      lastDispatchAt: this.lastDispatchAt,
      notificationsDelivered: this.notificationsDelivered,
      notificationsSuppressed: this.notificationsSuppressed,
    };
  }

  // Phase 8.6: clears only the telemetry fields getStatus() reports —
  // registered transports and the RuntimePolicy reference are untouched, so
  // dispatch()'s actual behavior (which transports get called, whether
  // policy is consulted, cooldown recording) is unaffected by having been
  // reset.
  resetStatistics(): void {
    this.lastDispatchAt = undefined;
    this.notificationsDelivered = 0;
    this.notificationsSuppressed = 0;
  }

  private groupByRepository(events: AttentionEvent[]): Map<string, AttentionEvent[]> {
    const groups = new Map<string, AttentionEvent[]>();
    for (const event of events) {
      const group = groups.get(event.repositoryId);
      if (group) {
        group.push(event);
      } else {
        groups.set(event.repositoryId, [event]);
      }
    }
    return groups;
  }
}
