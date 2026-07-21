import type { CurrentTaskReport, TaskCancellationOutcome } from "../executionstate/types";

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

// A simple, presentation-independent classification of "what's going on
// with this session right now" -- computed entirely from two already-owned
// facts (ClaudeSessionManager's own ClaudeSessionInfo.status, and whether
// ExecutionStateTracker currently reports an active task for the
// repository), never a new piece of tracked state. "active" vs "idle" is
// exactly the distinction between "a session exists and Claude is working
// right now" and "a session exists and could be continued, but nothing is
// happening this instant" -- ResponseFormatter maps this to an icon, it
// never computes it itself.
export type SessionLifecycleState = "active" | "idle" | "expired" | "none";

// The composed view ApplicationService.getSessionStatus() produces --
// ClaudeSessionInfo (owned by ClaudeSessionManager) plus repositoryName
// (IRepositoryRegistry, a cheap in-memory lookup) plus currentTask (the
// exact same ApplicationService.getCurrentTask() /task already exposes)
// plus the derived lifecycleState -- none of which ClaudeSessionManager
// computes or stores itself. Always returned (never undefined at the top
// level) so "no session at all" is itself a renderable report
// (lifecycleState: "none"), not an absence of one.
export interface SessionReport {
  repositoryName: string;
  info: ClaudeSessionInfo | undefined;
  lifecycleState: SessionLifecycleState;
  currentTask: CurrentTaskReport | undefined;
  // The same idle-timeout ClaudeSessionManager already enforces internally
  // (see IClaudeSessionManager.getIdleTimeoutMinutes()) -- surfaced here,
  // not duplicated, so ResponseFormatter can compute "expires in" from
  // info.lastUsedAt without hardcoding a second copy of the threshold.
  idleTimeoutMinutes: number;
}

// The composed outcome of /session stop -- taskOutcome is exactly what
// ApplicationService.cancelCurrentTask() already produces (Phase A.2,
// unchanged); sessionWasActive is a single extra fact (was there a session
// record to clear at all) so ResponseFormatter can report accurately even
// when nothing was running and no session existed either.
export interface SessionStopOutcome {
  taskOutcome: TaskCancellationOutcome;
  sessionWasActive: boolean;
}
