import type { IRuntimeAdministrationService } from "../admin/interfaces";
import type { RepositoryAssistanceReport } from "../assistance/types";
import type { AutonomousPlan } from "../autonomy/types";
import type { IRuntimeControlService } from "../control/interfaces";
import type { RepositoryInsightReport } from "../decisions/types";
import type { RuntimeDiagnosticsReport } from "../diagnostics/types";
import type { RepositorySnapshot } from "../intelligence/types";
import type { ProjectMemoryEvent } from "../memory/types";
import type { AutonomousPlanEvolutionReport, AutonomousPlanHistoryEntry } from "../planhistory/types";
import type { AutonomousPlanState, LivePlanComparison } from "../planstate/types";
import type { RepositoryRecommendationReport } from "../recommendations/types";
import type { RuntimeReport } from "../reporting/types";
import type { ClaudeSessionInfo } from "../session/types";
import type { RuntimeStatus } from "../status/types";
import type { EngineeringWorkspace } from "../workspace/types";

export interface IApplicationService {
  getRepositoryStatus(repositoryId?: string): Promise<RepositorySnapshot>;
  getRepositoryHistory(repositoryId?: string, limit?: number): Promise<ProjectMemoryEvent[]>;
  getRepositoryInsights(repositoryId?: string): Promise<RepositoryInsightReport>;
  getSessionStatus(repositoryId?: string): ClaudeSessionInfo | undefined;
  getRecommendations(repositoryId?: string): Promise<RepositoryRecommendationReport>;
  getEngineeringAssistance(repositoryId?: string): Promise<RepositoryAssistanceReport>;
  getEngineeringWorkspace(repositoryId?: string): Promise<EngineeringWorkspace>;
  // Phase 9.1: deliberately portfolio-wide, unlike every method above — it
  // has no repositoryId parameter because Autonomous Planning's entire
  // purpose is to reason across every registered repository at once, not
  // report on one. Read-only and dormant: nothing calls this yet.
  getAutonomousPlan(): Promise<AutonomousPlan>;
  // Phase 9.2: read-only queries over recorded planning cycles. Neither
  // method records anything — AutonomousPlanHistoryService owns record(),
  // and this class never calls it; when a planning cycle should actually be
  // recorded is a decision left to a future runtime/scheduler phase.
  getAutonomousPlanHistory(limit?: number): Promise<AutonomousPlanHistoryEntry[]>;
  // undefined only when no cycle has ever been recorded yet.
  getLatestAutonomousPlanEvolution(): Promise<AutonomousPlanEvolutionReport | undefined>;
  // Phase 9.3: the full active/superseded picture over recent history —
  // purely derived, records nothing.
  getAutonomousPlanStates(limit?: number): Promise<AutonomousPlanState[]>;
  // Phase 9.3: the current authoritative plan's state; undefined only when
  // no cycle has ever been recorded.
  getCurrentPlanState(): Promise<AutonomousPlanState | undefined>;
  // Phase 9.3: compares the live, not-yet-recorded plan against the
  // currently active recorded one. Never records anything — a pure "what
  // if" query.
  getLivePlanComparison(): Promise<LivePlanComparison>;
  // Phase 8.5: synchronous, unlike the methods above — RuntimeStatusService
  // and everything it reads from are in-memory getters, no I/O anywhere in
  // the chain, so there is nothing to await.
  getRuntimeStatus(): RuntimeStatus;
  // Phase 8.6: returns the held IRuntimeControlService reference itself, not
  // computed data — pure delegation, no orchestration of any kind.
  getRuntimeControl(): IRuntimeControlService;
  // Phase 8.7: returns the held IRuntimeAdministrationService reference
  // itself — pure delegation, no orchestration of any kind.
  getRuntimeAdministration(): IRuntimeAdministrationService;
  // Phase 8.8: synchronous, same reasoning as getRuntimeStatus() —
  // RuntimeDiagnosticsEngine.diagnose() is a pure, synchronous transform,
  // nothing here awaits anything.
  getRuntimeDiagnosis(): RuntimeDiagnosticsReport;
  // Phase 8.9: synchronous, same reasoning — RuntimeReportingEngine.buildReport()
  // is a pure, synchronous transform, nothing here awaits anything.
  getRuntimeReport(): RuntimeReport;
}
