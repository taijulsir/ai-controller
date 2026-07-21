import type { ClaudeSessionInfo, SessionLifecycleState } from "./types";

// Pure function, zero dependencies, computed entirely from two
// already-available facts -- no new state anywhere. "none" when there is no
// session record at all; "expired" when one exists but ClaudeSessionManager
// itself has already classified it that way; otherwise "active" exactly
// when something is currently running for the repository (ExecutionStateTracker's
// own existing signal, via ApplicationService.getCurrentTask() !== undefined),
// "idle" otherwise -- a session that could still be continued, but with
// nothing happening this instant.
export function deriveSessionLifecycleState(info: ClaudeSessionInfo | undefined, hasActiveTask: boolean): SessionLifecycleState {
  if (!info) {
    return "none";
  }
  if (info.status === "expired") {
    return "expired";
  }
  return hasActiveTask ? "active" : "idle";
}
