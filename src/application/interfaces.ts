import type { IRuntimeAdministrationService } from "../admin/interfaces";
import type { RepositoryAssistanceReport } from "../assistance/types";
import type { AutonomousPlan } from "../autonomy/types";
import type { IRuntimeControlService } from "../control/interfaces";
import type { RepositoryInsightReport } from "../decisions/types";
import type { RuntimeDiagnosticsReport } from "../diagnostics/types";
import type { RepositorySnapshot } from "../intelligence/types";
import type { ProjectMemoryEvent } from "../memory/types";
import type { AutonomousPlanEvolutionReport, AutonomousPlanHistoryEntry } from "../planhistory/types";
import type { AutonomousPlanAnalysisReport } from "../plananalysis/types";
import type { AutonomousPlanningSnapshot } from "../plan/types";
import type { AutonomousPlanReadinessReport } from "../planreadiness/types";
import type { AutonomousPlanSequencingReport } from "../plansequencing/types";
import type { AutonomousPlanState, LivePlanComparison } from "../planstate/types";
import type { AutonomousPlanSchedulingReport } from "../scheduling/types";
import type { RepositoryRecommendationReport } from "../recommendations/types";
import type { RuntimeReport } from "../reporting/types";
import type { ClaudeSessionInfo } from "../session/types";
import type { RuntimeStatus } from "../status/types";
import type { EngineeringWorkspace } from "../workspace/types";

// Phase 10.1: the narrow view of IApplicationService's one write operation,
// carved out specifically for AutonomousPlanRecordingWorker
// (src/runtime/AutonomousPlanRecordingWorker.ts) — so that worker's
// dependency is capable of nothing except triggering a recording, the same
// "no dependency capable of X, by construction" guarantee every other
// IBackgroundWorker already has (MonitoringWorker depends on
// IProactiveMonitor/IRepositoryRegistry/IAttentionDispatcher/
// IRuntimePolicyEngine, never the full IApplicationService). ApplicationService
// requires no change to satisfy this: it already implements a method with
// this exact name and signature, and IApplicationService below extends this
// interface rather than redeclaring the method, so there is exactly one
// declaration of it, not two.
export interface IAutonomousPlanCycleRecorder {
  // Phase 10: the first, and only, write operation IApplicationService
  // exposes — named recordAutonomousPlanCycle(), not getX(), so it reads
  // unambiguously as a write at every call site. Fetches the live plan via
  // ApplicationService's own getAutonomousPlan() (unchanged, no second
  // synthesis path), then delegates the write itself to
  // AutonomousPlanRecordingService — ApplicationService never touches
  // IAutonomousPlanHistoryService directly. As of Phase 10.1, this is called
  // on a timer by AutonomousPlanRecordingWorker; deciding whether that
  // cadence needs deduplication or retention policy remains a future
  // phase's decision, not this one's.
  recordAutonomousPlanCycle(): Promise<AutonomousPlanHistoryEntry>;
}

export interface IApplicationService extends IAutonomousPlanCycleRecorder {
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
  // report on one. Read-only itself — synthesizing a live plan records
  // nothing — though as of Phase 10 it is also the first step of
  // recordAutonomousPlanCycle() below, which fetches a live plan via this
  // exact method before handing it to AutonomousPlanRecordingService.
  getAutonomousPlan(): Promise<AutonomousPlan>;
  // Phase 9.2: read-only queries over recorded planning cycles. Neither
  // method records anything itself — AutonomousPlanHistoryService owns
  // record(), and these two methods never call it. As of Phase 10, the one
  // place this class does call it is recordAutonomousPlanCycle() below,
  // routed through AutonomousPlanRecordingService rather than either of
  // these query methods.
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
  // Phase 9.4: the composed view — live plan, current authoritative state,
  // and the comparison between them, all describing the same instant.
  // Never records anything.
  getAutonomousPlanningSnapshot(): Promise<AutonomousPlanningSnapshot>;
  // Phase 9.5: multi-cycle pattern analysis (chronic, sustained escalation,
  // flapping) over a window of recorded cycles. Pure delegation —
  // AutonomousPlanningService owns fetching the window and invoking the
  // analysis engine; this class never re-derives it.
  getAutonomousPlanAnalysis(limit?: number): Promise<AutonomousPlanAnalysisReport>;
  // Phase 9.6: purely descriptive readiness — confidence, currentness,
  // observed multi-cycle indicators, and a derived level/score — never a
  // review requirement, approval, or eligibility decision. The one place
  // this class composes across the Planning and Readiness domains.
  getAutonomousPlanReadiness(limit?: number): Promise<AutonomousPlanReadinessReport>;
  // Phase 9.7: a deterministic, descriptive ordering of Readiness-assessed
  // items — ranked by readiness level (never score), then cycle count,
  // then repositoryId, then sourceRecommendationKind. No timing, cadence,
  // interval, scheduling, approval, eligibility, or execution concept.
  // The one place this class composes across the Readiness and Plan
  // Sequencing domains.
  getAutonomousPlanSequence(limit?: number): Promise<AutonomousPlanSequencingReport>;
  // Phase 9.8: a cadence classification only — frequent, periodic, or
  // infrequent — per already-sequenced item, preserving Plan Sequencing's
  // order verbatim. No duration, interval, timer, or runtime policy
  // concept. The one place this class composes across the Plan Sequencing
  // and Scheduling domains.
  getAutonomousPlanSchedule(limit?: number): Promise<AutonomousPlanSchedulingReport>;
  // recordAutonomousPlanCycle() lives on IAutonomousPlanCycleRecorder above,
  // which this interface extends — see that interface's own doc comment.
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
