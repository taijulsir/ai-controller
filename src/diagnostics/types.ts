import type { Severity } from "../domain/severity/Severity";

export type RuntimeHealthLevel = "healthy" | "degraded" | "unhealthy";

// Strongly typed, closed set — mirrors RecommendationKind's shape exactly:
// each kind name already communicates what's being reported, so there is no
// separate "message template" field kept in lockstep with it.
//
// "DispatcherUnavailable" is deliberately absent: RuntimeStatus/
// AttentionDispatcherStatus (Phase 8.5) has no field representing whether
// the dispatcher itself is available — AttentionDispatcher has no start()/
// stop() lifecycle at all, unlike BackgroundRuntime/MonitoringWorker, so
// there is nothing in the current data model for this engine to observe.
// See RuntimeDiagnosticsEngine's own doc comment for the full explanation —
// this is a discovered, documented gap, not an oversight.
export type DiagnosticFindingKind =
  | "RuntimeStopped"
  | "WorkerUnavailable"
  | "MonitoringStale"
  | "MaintenanceModeActive"
  | "QuietHoursActive"
  | "NotificationBudgetExhausted"
  | "RepositoryMonitoringDisabled"
  | "RepositoryCooldownActive";

export interface DiagnosticFinding {
  kind: DiagnosticFindingKind;
  severity: Severity;
  message: string;
}

// An immutable, point-in-time verdict — same convention as every other
// "report" type in this codebase (RepositorySnapshot, RuntimeStatus, ...).
// Getting a fresher diagnosis means calling
// IRuntimeDiagnosticsEngine.diagnose() again with a fresh RuntimeStatus, not
// mutating or re-reading this object.
export interface RuntimeDiagnosticsReport {
  health: RuntimeHealthLevel;
  // Produced by RuntimeDiagnosticsEngine itself — callers never assemble this
  // string; see RuntimeDiagnosticsEngine.buildSummary().
  summary: string;
  findings: DiagnosticFinding[];
  generatedAt: Date;
}
