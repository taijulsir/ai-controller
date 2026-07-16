import type { AttentionEvent } from "../monitoring/types";
import type { AttentionDispatcherStatus } from "./types";

// Fan-out only: hand a batch of already-deduplicated AttentionEvents to
// whichever transports are registered. No retry policy, no batching policy,
// no queue, no persistence, no additional deduplication — RecommendationStateStore
// (via ProactiveMonitor) already guarantees every event handed to dispatch()
// represents a genuinely new transition; this contract does not re-derive or
// second-guess that.
export interface IAttentionDispatcher {
  dispatch(events: AttentionEvent[]): Promise<void>;
  // Read-only (Phase 8.5): reports counters already tracked for dispatch()'s
  // own bookkeeping — never triggers a dispatch or any other side effect.
  getStatus(): AttentionDispatcherStatus;
  // Phase 8.6: clears the counters getStatus() reports (lastDispatchAt,
  // notificationsDelivered, notificationsSuppressed) — never touches
  // registered transports or RuntimePolicy, so dispatch()'s actual behavior
  // is unaffected by having been reset.
  resetStatistics(): void;
}

// One delivery medium. Deliberately narrow: turn an already-batched,
// already-deduplicated set of transport-neutral events into a message in its
// own medium and send it — nothing here decides whether to send, retries, or
// knows about MonitoringWorker/ProactiveMonitor/dedup state.
export interface IAttentionTransport {
  deliver(events: AttentionEvent[]): Promise<void>;
}
