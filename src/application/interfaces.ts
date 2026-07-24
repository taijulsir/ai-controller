import type { IRuntimeAdministrationService } from "../admin/interfaces";
import type { ArtifactContent, ArtifactList, ArtifactMetadata } from "../artifacts";
import type { RepositoryAssistanceReport } from "../assistance/types";
import type { AutonomousPlan } from "../autonomy/types";
import type { IRuntimeControlService } from "../control/interfaces";
import type { RepositoryInsightReport } from "../decisions/types";
import type { RuntimeDiagnosticsReport } from "../diagnostics/types";
import type { CurrentTaskReport, TaskCancellationOutcome } from "../executionstate/types";
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
import type { SessionReport, SessionStopOutcome } from "../session/types";
import type { RuntimeStatus } from "../status/types";
import type { UndoOutcome } from "../undo/types";
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

// Phase 11: the narrow, read-only view of IApplicationService's one
// scheduling query, carved out specifically for AutonomousExecutionOrchestrator
// (src/autonomousexecution/AutonomousExecutionOrchestrator.ts) — so that
// class's read dependency is capable of nothing except reading the
// schedule, never getRuntimeControl()/getRuntimeAdministration()/any other
// IApplicationService surface. This matters more here than it did for
// IAutonomousPlanCycleRecorder (Phase 10.1): AutonomousExecutionOrchestrator
// already holds one broad, dangerous capability (IExecutionPipeline) — an
// unrelated second one (runtime control) reachable through its other
// dependency would be the least likely kind of mistake for review to catch,
// precisely because the class already legitimately does dangerous things.
// ApplicationService requires no change to satisfy this: it already
// implements a method with this exact name and signature, and
// IApplicationService below extends this interface rather than redeclaring
// the method, so there is exactly one declaration of it, not two.
export interface IAutonomousPlanScheduleProvider {
  // Phase 9.8's own method, unchanged — see its doc comment on
  // IApplicationService below for what it does. Exposed here as its own
  // narrow interface so a consumer whose only legitimate need is "read the
  // schedule" never gains type-level access to anything else.
  getAutonomousPlanSchedule(limit?: number): Promise<AutonomousPlanSchedulingReport>;
}

export interface IApplicationService extends IAutonomousPlanCycleRecorder, IAutonomousPlanScheduleProvider {
  getRepositoryStatus(repositoryId?: string): Promise<RepositorySnapshot>;
  getRepositoryHistory(repositoryId?: string, limit?: number): Promise<ProjectMemoryEvent[]>;
  getRepositoryInsights(repositoryId?: string): Promise<RepositoryInsightReport>;
  // Phase E: composes ClaudeSessionInfo, the repository's display name, and
  // the same getCurrentTask() every /task query already exposes, plus a
  // derived lifecycleState -- see ApplicationService's own doc comment.
  // Always returns a real report; "no session at all" is itself a
  // renderable fact, not undefined.
  getSessionStatus(repositoryId?: string): SessionReport;
  // Phase E: always succeeds, safe to call at any time -- see
  // ApplicationService's own doc comment for why resetting mid-flight never
  // affects anything already running. Returns the resolved repository's
  // display name so the confirmation can name it explicitly, the same way
  // every other repo-scoped confirmation in this codebase already does.
  resetSession(repositoryId?: string): string;
  // Phase E: composes cancelCurrentTask() (Phase A.2, unchanged) with
  // resetSession() above -- see ApplicationService's own doc comment.
  stopSession(repositoryId?: string): SessionStopOutcome;
  // Composed from two independently-owned sources, neither duplicated here:
  // IExecutionStateReader (ExecutionStateTracker) reports only that an
  // execution exists and its metadata; IApprovalPendingReader
  // (TelegramApprovalProvider) reports only whether that execution's
  // correlationId is currently awaiting a Telegram decision. This is the one
  // place those two facts meet to produce a status. Synchronous, like
  // getSessionStatus() above -- both sources are in-memory reads, nothing
  // here awaits anything. undefined when no execution is currently tracked
  // for the resolved repository (rendered by ResponseFormatter as "Idle").
  getCurrentTask(repositoryId?: string): CurrentTaskReport | undefined;
  // Phase A.2: composes execution state, approval-pending state, and
  // ITaskCancellationPolicy's own judgment into one outcome -- see
  // ApplicationService's own doc comment for the full branching. Synchronous
  // for the same reason getCurrentTask() is: every source it reads is
  // in-memory, and ITaskCanceller.cancel()/IApprovalCanceller.reject() are
  // themselves synchronous (AbortController.abort() and resolving an
  // already-pending Promise are not I/O).
  cancelCurrentTask(repositoryId?: string): TaskCancellationOutcome;
  // Phase B: composes IUndoService's build/execute phases -- see
  // ApplicationService's own doc comment. Async, unlike getCurrentTask()/
  // cancelCurrentTask(): UndoService reads project memory history from disk
  // and calls git, neither of which is an in-memory read.
  undoLastExecution(repositoryId?: string): Promise<UndoOutcome>;
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
  // and Scheduling domains. Declared on IAutonomousPlanScheduleProvider
  // above, which this interface extends — see that interface's own doc
  // comment.
  //
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

  // Artifact Management: unlike every repository-scoped method above, these
  // never call resolveRepositoryId -- an unset repositoryId means "across
  // every repository," not "use the active one," since browsing/retrieving
  // artifacts is a portfolio-wide concern the same way getAutonomousPlan()
  // is, not a single-repository one.
  listArtifacts(repositoryId?: string): Promise<ArtifactList>;
  getArtifact(id: string): Promise<ArtifactMetadata | null>;
  getArtifactContent(id: string): Promise<ArtifactContent | null>;
  searchArtifacts(query: string, repositoryId?: string): Promise<ArtifactList>;
  // Destructive -- TelegramAdapter gates this behind TelegramSecurity.isAdmin
  // before ever calling it, the same way it already gates the mutating
  // "task cancel"/"undo" surfaces at the transport layer, not here.
  deleteArtifact(id: string): Promise<boolean>;
  // Maintenance, not a business query -- same admin gate as deleteArtifact.
  rebuildArtifactIndex(): Promise<{ before: number; after: number; elapsedMs: number }>;
}
