import type { IRuntimeAdministrationService } from "../admin/interfaces";
import type { IApprovalCanceller, IApprovalPendingReader } from "../approval/interfaces";
import type {
  ArtifactContent,
  ArtifactDeletionResult,
  ArtifactList,
  ArtifactMetadata,
  IArtifactMaintenance,
  IArtifactService,
} from "../artifacts";
import type { IEngineeringAssistanceEngine } from "../assistance/interfaces";
import type { RepositoryAssistanceReport } from "../assistance/types";
import type { IAutonomousPlanningEngine } from "../autonomy/interfaces";
import type { AutonomousPlan } from "../autonomy/types";
import type { IRuntimeControlService } from "../control/interfaces";
import type { IDecisionEngine } from "../decisions/interfaces";
import type { RepositoryInsightReport } from "../decisions/types";
import type { IRuntimeDiagnosticsEngine } from "../diagnostics/interfaces";
import type { RuntimeDiagnosticsReport } from "../diagnostics/types";
import type { IExecutionStateReader } from "../executionstate/interfaces";
import type { CurrentTaskReport, TaskCancellationOutcome } from "../executionstate/types";
import type { IRepositoryIntelligenceService } from "../intelligence/interfaces";
import type { RepositorySnapshot } from "../intelligence/types";
import type { IProjectMemoryService } from "../memory/interfaces";
import type { ProjectMemoryEvent } from "../memory/types";
import type { IProactiveMonitor } from "../monitoring/interfaces";
import type { AutonomousPlanEvolutionReport, AutonomousPlanHistoryEntry } from "../planhistory/types";
import type { AutonomousPlanAnalysisReport } from "../plananalysis/types";
import type { IAutonomousPlanningService } from "../plan/interfaces";
import type { AutonomousPlanningSnapshot } from "../plan/types";
import type { ITaskCancellationPolicy, ITaskCanceller } from "../planner/interfaces";
import type { TaskType } from "../planner/types";
import type { IAutonomousPlanReadinessEngine } from "../planreadiness/interfaces";
import type { AutonomousPlanReadinessReport } from "../planreadiness/types";
import type { IAutonomousPlanRecordingService } from "../planrecording/interfaces";
import type { IAutonomousPlanSequencingEngine } from "../plansequencing/interfaces";
import type { AutonomousPlanSequencingReport } from "../plansequencing/types";
import type { AutonomousPlanState, LivePlanComparison } from "../planstate/types";
import type { IAutonomousPlanSchedulingEngine } from "../scheduling/interfaces";
import type { AutonomousPlanSchedulingReport } from "../scheduling/types";
import type { IRecommendationEngine } from "../recommendations/interfaces";
import type { RepositoryRecommendationReport } from "../recommendations/types";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import type { IRuntimeReportingEngine } from "../reporting/interfaces";
import type { RuntimeReport } from "../reporting/types";
import type { IClaudeSessionManager } from "../session/interfaces";
import { deriveSessionLifecycleState } from "../session/SessionLifecycle";
import type { SessionReport, SessionStopOutcome } from "../session/types";
import type { IRuntimeStatusService } from "../status/interfaces";
import type { RuntimeStatus } from "../status/types";
import type { IUndoService } from "../undo/interfaces";
import type { UndoOutcome } from "../undo/types";
import type { EngineeringWorkspace } from "../workspace/types";
import { NoActiveRepositoryError } from "./errors";
import type { IApplicationService } from "./interfaces";

export class ApplicationService implements IApplicationService {
  constructor(
    private readonly repositoryIntelligence: IRepositoryIntelligenceService,
    private readonly projectMemory: IProjectMemoryService,
    private readonly decisionEngine: IDecisionEngine,
    private readonly sessionManager: IClaudeSessionManager,
    private readonly repositoryRegistry: IRepositoryRegistry,
    private readonly recommendationEngine: IRecommendationEngine,
    private readonly engineeringAssistanceEngine: IEngineeringAssistanceEngine,
    // Phase 8.5: the composition root actually passes a DeferredRuntimeStatusService
    // here (bound to the real RuntimeStatusService later, once the Background
    // Runtime cluster is built) — see DeferredRuntimeStatusService's own doc
    // comment for why that seam exists. From this class's perspective it is
    // simply an IRuntimeStatusService, exactly like every other dependency.
    private readonly runtimeStatusService: IRuntimeStatusService,
    // Phase 8.8: zero constructor dependencies of its own (a pure transform,
    // like PlanningEngine/ExecutionCoordinator/RecommendationEngine) — no
    // deferred seam is needed for this one, unlike the three runtime-facade
    // dependencies below, since it never reaches back toward
    // ApplicationService or anything else.
    private readonly runtimeDiagnosticsEngine: IRuntimeDiagnosticsEngine,
    // Phase 8.9: zero constructor dependencies of its own, same shape as
    // runtimeDiagnosticsEngine above — no deferred seam needed.
    private readonly runtimeReportingEngine: IRuntimeReportingEngine,
    // Phase 8.6: same seam shape as runtimeStatusService above — the
    // composition root actually passes a DeferredRuntimeControlService here,
    // bound to the real RuntimeControlService once the Background Runtime
    // cluster exists. From this class's perspective it is simply an
    // IRuntimeControlService.
    private readonly runtimeControlService: IRuntimeControlService,
    // Phase 8.7: same seam shape as the two above — the composition root
    // actually passes a DeferredRuntimeAdministrationService here, bound to
    // the real RuntimeAdministrationService once the Background Runtime
    // cluster exists.
    private readonly runtimeAdministrationService: IRuntimeAdministrationService,
    // Phase 9.1: zero constructor dependencies of its own (a pure transform,
    // like recommendationEngine/engineeringAssistanceEngine/
    // runtimeDiagnosticsEngine/runtimeReportingEngine above) — no deferred
    // seam needed, since it never reaches back toward ApplicationService or
    // anything else.
    private readonly autonomousPlanningEngine: IAutonomousPlanningEngine,
    // Phase 9.4: replaces the two separate Phase 9.2/9.3 dependencies this
    // class held directly before (AutonomousPlanHistoryService,
    // AutonomousPlanStateEngine) with one façade over both. Neither
    // AutonomousPlanHistoryService nor AutonomousPlanStateEngine changed —
    // this class simply no longer wires them individually or re-implements
    // their composition itself. AutonomousPlanningService never calls
    // record(), even though it holds an IAutonomousPlanHistoryService
    // reference that exposes it — recording, and when a planning cycle
    // should be recorded, remain outside this class entirely, exactly as
    // before.
    private readonly autonomousPlanningService: IAutonomousPlanningService,
    // Phase 9.6: a new domain, not part of the Planning façade — see
    // AutonomousPlanReadinessEngine's own doc comment for why it stays
    // separate. Zero constructor dependencies of its own (a pure transform,
    // same shape as autonomousPlanningEngine above) — no deferred seam
    // needed. getAutonomousPlanReadiness() below is the one place this
    // class performs legitimate cross-domain composition (Planning +
    // Readiness), the same role it already plays for
    // getEngineeringWorkspace() across the recommendations/assistance/
    // memory/monitoring domains — not a regression of Phase 9.5's
    // refinement, which was specifically about not re-deriving a use case
    // that belongs inside a single domain's own façade.
    private readonly readinessEngine: IAutonomousPlanReadinessEngine,
    // Phase 9.7: a new domain, not part of Readiness — see
    // AutonomousPlanSequencingEngine's own doc comment for why it stays
    // separate. Zero constructor dependencies of its own — no deferred seam
    // needed. getAutonomousPlanSequence() below is the one place this class
    // composes across Readiness and Sequencing, the same cross-domain role
    // it already plays for getAutonomousPlanReadiness() (Planning +
    // Readiness) and getEngineeringWorkspace().
    private readonly sequencingEngine: IAutonomousPlanSequencingEngine,
    // Phase 9.8: a new domain, not part of Plan Sequencing — see
    // AutonomousPlanSchedulingEngine's own doc comment for why it stays
    // separate. Zero constructor dependencies of its own — no deferred seam
    // needed. getAutonomousPlanSchedule() below is the one place this class
    // composes across Plan Sequencing and Scheduling, the same cross-domain
    // role it already plays at every prior seam in this chain.
    private readonly schedulingEngine: IAutonomousPlanSchedulingEngine,
    // Phase 10: the first write-capable dependency this class holds. Zero
    // constructor dependencies of its own beyond IAutonomousPlanHistoryService
    // (not visible from here — this class only ever sees the
    // IAutonomousPlanRecordingService abstraction). Deliberately separate
    // from autonomousPlanningService above: that façade's own doc comment
    // treats never calling record() as a permanent property of itself, so
    // the write path is a sibling this class composes with directly, not a
    // method added to the read façade. recordAutonomousPlanCycle() below is
    // the one place this class and this dependency meet.
    private readonly recordingService: IAutonomousPlanRecordingService,
    // Phase A (Task Management): both narrow read-only facades over state
    // this class never owns or duplicates -- ExecutionStateTracker (via
    // IExecutionStateReader) owns execution metadata, TelegramApprovalProvider
    // (via IApprovalPendingReader) owns approval-pending state. Neither
    // concrete instance exists yet when ApplicationService is constructed in
    // src/index.ts (both wrap collaborators built later in the same
    // composition root), so a Deferred* seam is passed here for each,
    // exactly the same ordering-constraint shape as runtimeStatusService/
    // runtimeControlService/runtimeAdministrationService above. getCurrentTask()
    // below is the one place this class composes across both.
    private readonly executionStateReader: IExecutionStateReader,
    private readonly approvalPendingReader: IApprovalPendingReader,
    // Phase A.2 (/task cancel): three more narrow, independently-owned
    // dependencies this class composes but never duplicates. ITaskCanceller
    // (TaskPlanner) is purely mechanical -- it aborts whatever's registered,
    // it has no opinion on whether that's wise. ITaskCancellationPolicy is
    // the pure, stateless judgment of which task types are actually worth
    // aborting (same shape as ApprovalPolicy) -- consulted here, before
    // taskCanceller is ever called, so TaskPlanner itself never needs to
    // know about cancellability. IApprovalCanceller (TelegramApprovalProvider)
    // rejects a still-pending approval through its own existing settle()
    // path -- a different mechanism entirely from aborting a running task,
    // needed because cancelCurrentTask() below has two structurally
    // different things it might need to stop. taskCanceller and
    // approvalCanceller are both Deferred* seams (same ordering-constraint
    // shape as executionStateReader/approvalPendingReader above); the policy
    // needs no seam at all, being a pure transform with zero dependencies of
    // its own.
    private readonly taskCanceller: ITaskCanceller,
    private readonly approvalCanceller: IApprovalCanceller,
    private readonly taskCancellationPolicy: ITaskCancellationPolicy,
    // Phase B (Undo): a single collaborator, not another handful of narrow
    // Deferred* seams -- UndoService's own dependencies (IRepositoryRegistry,
    // IExecutionStateReader, IUndoableExecutionHistoryProvider, IUndoRecorder)
    // are all already available by the time UndoService is constructed in
    // src/index.ts (the same deferredExecutionStateReader instance
    // getCurrentTask()/cancelCurrentTask() already use, and the same
    // projectMemory instance passed in above), so no new ordering-constraint
    // seam is needed here at all.
    private readonly undoService: IUndoService,
    // Artifact Management: the same single ArtifactService/maintenance pair
    // src/index.ts constructs via createArtifactModule() for TaskArtifactRecorder
    // -- this class never constructs or rebuilds its own, it only exposes
    // read/search/delete/rebuild over the one shared instance.
    private readonly artifactService: IArtifactService,
    private readonly artifactMaintenance: IArtifactMaintenance,
    // Optional: Engineering Workspace must compose successfully whether or
    // not a monitoring service exists in this deployment. Monitoring is not
    // wired into the composition root yet (Phase 7.7's scheduler/runtime
    // integration is still a later phase) — when absent, attentionEvents is
    // simply undefined; nothing here infers or fabricates a substitute.
    private readonly proactiveMonitor?: IProactiveMonitor,
  ) {}

  async getRepositoryStatus(repositoryId?: string): Promise<RepositorySnapshot> {
    return this.repositoryIntelligence.getSnapshot(this.resolveRepositoryId(repositoryId));
  }

  async getRepositoryHistory(repositoryId?: string, limit?: number): Promise<ProjectMemoryEvent[]> {
    return this.projectMemory.getRecentEvents({ repositoryId: this.resolveRepositoryId(repositoryId), limit });
  }

  async getRepositoryInsights(repositoryId?: string): Promise<RepositoryInsightReport> {
    const resolvedId = this.resolveRepositoryId(repositoryId);
    const snapshot = await this.repositoryIntelligence.getSnapshot(resolvedId);
    return this.decisionEngine.analyze(snapshot);
  }

  // Composes three independently-owned facts, none re-derived or
  // duplicated here: ClaudeSessionInfo (ClaudeSessionManager's own
  // metadata), the repository's display name (IRepositoryRegistry, the same
  // cheap lookup getCurrentTask() already uses), and currentTask -- reusing
  // getCurrentTask() itself rather than reading ExecutionStateTracker a
  // second, independent way. lifecycleState is a pure function of the first
  // and third facts (see deriveSessionLifecycleState) -- no new state of its
  // own. Always returns a real report, never undefined: "no session at all"
  // is itself a renderable fact (lifecycleState: "none"), not an absence of
  // one.
  getSessionStatus(repositoryId?: string): SessionReport {
    const resolvedId = this.resolveRepositoryId(repositoryId);
    const info = this.sessionManager.getSessionStatus(resolvedId);
    const currentTask = this.getCurrentTask(resolvedId);

    return {
      repositoryName: this.repositoryRegistry.getRepository(resolvedId).name,
      info,
      lifecycleState: deriveSessionLifecycleState(info, currentTask !== undefined),
      currentTask,
      idleTimeoutMinutes: this.sessionManager.getIdleTimeoutMinutes(),
    };
  }

  // /session reset: always succeeds (a plain, idempotent delete), safe to
  // call at any time -- resolveSession() is only ever consulted once per
  // task attempt, at workflow-creation time before Claude even starts, so
  // resetting mid-flight never affects anything already running, only the
  // next attempt.
  resetSession(repositoryId?: string): string {
    const resolvedId = this.resolveRepositoryId(repositoryId);
    this.sessionManager.resetSession(resolvedId);
    return this.repositoryRegistry.getRepository(resolvedId).name;
  }

  // /session stop: composes cancelCurrentTask() (Phase A.2, entirely
  // unchanged -- reused verbatim, not reimplemented) with resetSession()
  // above. Cancelling stops whatever is actually running right now (if
  // anything, and if it's a cancellable type); resetting afterward ensures
  // the next attempt starts a fresh conversation rather than trying to
  // --continue one whose last turn was just forcibly terminated mid-stream.
  // sessionWasActive is read before either write, so it reports the
  // pre-stop state accurately.
  stopSession(repositoryId?: string): SessionStopOutcome {
    const resolvedId = this.resolveRepositoryId(repositoryId);
    const sessionWasActive = this.sessionManager.getSessionStatus(resolvedId) !== undefined;
    const taskOutcome = this.cancelCurrentTask(resolvedId);
    this.sessionManager.resetSession(resolvedId);
    return { taskOutcome, sessionWasActive };
  }

  // The one place execution state and approval state meet. Reuses the same
  // resolveRepositoryId() every other query already follows (repo=<id>
  // override, else the active repository) so /task behaves identically to
  // /status, /branch, and /recommendations. ExecutionStateTracker reports
  // only that an execution exists; TelegramApprovalProvider (through
  // IApprovalPendingReader) reports only whether that execution's own
  // correlationId is currently awaiting a decision -- neither fact is
  // re-derived or duplicated here, only combined.
  getCurrentTask(repositoryId?: string): CurrentTaskReport | undefined {
    const resolvedId = this.resolveRepositoryId(repositoryId);
    const snapshot = this.executionStateReader.getCurrent(resolvedId);
    if (!snapshot) {
      return undefined;
    }

    const status = this.approvalPendingReader.isPending(snapshot.correlationId) ? "waiting-approval" : "running";
    return {
      status,
      repositoryName: this.repositoryRegistry.getRepository(resolvedId).name,
      snapshot,
    };
  }

  // Reuses getCurrentTask()'s own logic implicitly via the same
  // executionStateReader/approvalPendingReader reads (not by calling
  // getCurrentTask() itself, since that method's CurrentTaskReport shape
  // carries a repositoryName this method doesn't need) -- still exactly one
  // read of each underlying fact, never a second, independent one. Branches
  // on which of two structurally different things needs stopping (a pending
  // approval vs. a running task) before ever calling either canceller, so
  // neither TaskPlanner nor TelegramApprovalProvider has to guess which
  // situation it's being asked to handle.
  cancelCurrentTask(repositoryId?: string): TaskCancellationOutcome {
    const resolvedId = this.resolveRepositoryId(repositoryId);
    const snapshot = this.executionStateReader.getCurrent(resolvedId);
    if (!snapshot) {
      return { kind: "nothing-running" };
    }

    if (this.approvalPendingReader.isPending(snapshot.correlationId)) {
      const rejected = this.approvalCanceller.reject(snapshot.correlationId, "Cancelled by user via /task cancel.");
      return rejected ? { kind: "cancelled-approval", snapshot } : { kind: "already-finished" };
    }

    // The task type actually executing right now: currentStep once a
    // workflow's own step is in flight, otherwise the bare task itself --
    // never re-derived, just read off the same snapshot CurrentTaskReport
    // already exposes. Both fields are always populated from a real
    // Task["type"] by ExecutionStateTracker (or left "", handled by the
    // `|| snapshot.task` fallback and the emptiness check below) -- the cast
    // is the same kind of intentional dynamic-to-static boundary
    // WorkflowOrchestrator's own buildStepTask() already documents for
    // itself.
    const currentTaskType = (snapshot.currentStep || snapshot.task) as TaskType | "";
    if (!currentTaskType || !this.taskCancellationPolicy.canCancel(currentTaskType as TaskType)) {
      return { kind: "not-cancellable", snapshot };
    }

    if (this.taskCanceller.cancel(snapshot.correlationId)) {
      return { kind: "cancelled", snapshot };
    }
    // cancel() returned false: either it finished on its own in the instant
    // between the two reads above, or a previous cancel request already
    // aborted it and it hasn't unwound yet -- getCurrent() still finding a
    // record distinguishes the latter from the former.
    return this.executionStateReader.getCurrent(resolvedId) ? { kind: "already-cancelling", snapshot } : { kind: "already-finished" };
  }

  // Composes IUndoService's two phases exactly the way its own doc comment
  // anticipates: build the plan, then either report why it can't proceed or
  // hand it straight to executeUndoPlan() -- this class never re-derives any
  // of the analysis itself, only decides which of the two next steps to take.
  // Reuses the same resolveRepositoryId() convention as every other method
  // here, so /undo behaves identically to /status, /branch, /recommendations,
  // and /task.
  async undoLastExecution(repositoryId?: string): Promise<UndoOutcome> {
    const resolvedId = this.resolveRepositoryId(repositoryId);
    const plan = await this.undoService.buildUndoPlan(resolvedId);

    switch (plan.status) {
      case "nothing-to-undo":
        return { kind: "nothing-to-undo" };
      case "execution-in-progress":
        return { kind: "execution-in-progress" };
      case "drift-detected":
        return { kind: "drift-detected", checkpointId: plan.checkpointId!, taskType: plan.taskType!, conflictingFiles: plan.conflictingFiles };
      case "ready":
        return this.undoService.executeUndoPlan(plan);
    }
  }

  // Fetches the snapshot and analyzes it exactly once, then hands both —
  // plus the current session status — to the pure RecommendationEngine.
  // Mirrors getRepositoryInsights()'s own fetch-once discipline; no data
  // this method reads is ever recomputed a second time.
  async getRecommendations(repositoryId?: string): Promise<RepositoryRecommendationReport> {
    const resolvedId = this.resolveRepositoryId(repositoryId);
    const snapshot = await this.repositoryIntelligence.getSnapshot(resolvedId);
    const insightReport = await this.decisionEngine.analyze(snapshot);
    const session = this.sessionManager.getSessionStatus(resolvedId);
    return this.recommendationEngine.recommend(snapshot, insightReport, session);
  }

  // Reuses getRecommendations() rather than re-deriving anything: the
  // already-computed, already-prioritized RepositoryRecommendationReport is
  // handed straight to the pure EngineeringAssistanceEngine.
  async getEngineeringAssistance(repositoryId?: string): Promise<RepositoryAssistanceReport> {
    const recommendationReport = await this.getRecommendations(repositoryId);
    return this.engineeringAssistanceEngine.propose(recommendationReport);
  }

  // Pure composition — every analysis-producing call happens exactly once
  // (the snapshot is fetched once and reused for insights/recommendations;
  // recommendations are computed once and reused for assistance), then
  // assembled directly rather than routed back through this class's own
  // sibling methods, which would each independently re-fetch/re-analyze.
  //
  // When a monitoring service is available, calling its evaluate() here is
  // a deliberate, real "check-in" — not a side-effect accident. Monitoring
  // alone owns its state-transition/dedup semantics regardless of who
  // calls evaluate() or when; this composition is simply one legitimate
  // caller among any others that may exist later.
  async getEngineeringWorkspace(repositoryId?: string): Promise<EngineeringWorkspace> {
    const resolvedId = this.resolveRepositoryId(repositoryId);
    const snapshot = await this.repositoryIntelligence.getSnapshot(resolvedId);
    const insightReport = await this.decisionEngine.analyze(snapshot);
    const session = this.sessionManager.getSessionStatus(resolvedId);
    const recommendationReport = this.recommendationEngine.recommend(snapshot, insightReport, session);
    const assistanceReport = this.engineeringAssistanceEngine.propose(recommendationReport);
    const recentHistory = await this.projectMemory.getRecentEvents({ repositoryId: resolvedId });
    const attentionEvents = this.proactiveMonitor ? await this.proactiveMonitor.evaluate(resolvedId) : undefined;

    return {
      repositoryId: resolvedId,
      generatedAt: new Date(),
      repository: snapshot,
      insights: insightReport,
      recommendations: recommendationReport,
      assistance: assistanceReport,
      session,
      recentHistory,
      attentionEvents,
    };
  }

  // Phase 8.5: pure delegation, no additional logic — RuntimeStatusService
  // already assembles the full immutable snapshot; this method exists only
  // so Telegram/future front-ends have exactly one read-facade to depend on,
  // matching every other query this class exposes.
  getRuntimeStatus(): RuntimeStatus {
    return this.runtimeStatusService.getStatus();
  }

  // Phase 8.6: pure delegation — returns the held reference itself, no
  // orchestration. Whoever calls a method on the returned object reaches
  // RuntimeControlService directly.
  getRuntimeControl(): IRuntimeControlService {
    return this.runtimeControlService;
  }

  // Phase 8.7: pure delegation — returns the held reference itself, no
  // orchestration.
  getRuntimeAdministration(): IRuntimeAdministrationService {
    return this.runtimeAdministrationService;
  }

  // Phase 8.8: orchestration only, same fetch-once-then-analyze shape as
  // getRepositoryInsights() (getSnapshot() then decisionEngine.analyze()) —
  // fetch the RuntimeStatus exactly once, hand it to the pure
  // RuntimeDiagnosticsEngine, return what it produces. No branching, no
  // interpretation, no message assembly happens here.
  getRuntimeDiagnosis(): RuntimeDiagnosticsReport {
    const status = this.runtimeStatusService.getStatus();
    return this.runtimeDiagnosticsEngine.diagnose(status);
  }

  // Phase 8.9: fetches RuntimeStatus exactly once and reuses that same
  // object for both diagnose() and buildReport() — deliberately does NOT
  // call getRuntimeDiagnosis() (which would fetch a second, independent
  // RuntimeStatus snapshot), since the report's raw-facts sections and its
  // diagnosis must describe the exact same instant, not two separately
  // fetched reads that could disagree.
  getRuntimeReport(): RuntimeReport {
    const status = this.runtimeStatusService.getStatus();
    const diagnostics = this.runtimeDiagnosticsEngine.diagnose(status);
    return this.runtimeReportingEngine.buildReport(status, diagnostics);
  }

  async listArtifacts(repositoryId?: string): Promise<ArtifactList> {
    return this.artifactService.list(repositoryId ? { repositoryId } : {});
  }

  async getArtifact(id: string): Promise<ArtifactMetadata | null> {
    return this.artifactService.get(id);
  }

  async getArtifactContent(id: string): Promise<ArtifactContent | null> {
    return this.artifactService.getContent(id);
  }

  async searchArtifacts(query: string, repositoryId?: string): Promise<ArtifactList> {
    return this.artifactService.search(query, repositoryId ? { repositoryId } : {});
  }

  async deleteArtifacts(ids: string[]): Promise<ArtifactDeletionResult> {
    return this.artifactService.deleteMany(ids);
  }

  async deleteAllArtifacts(confirmed: boolean): Promise<{ totalDeleted: number; totalRemaining: number; elapsedMs: number }> {
    if (!confirmed) {
      const totalRemaining = (await this.artifactService.list({ limit: 1 })).total;
      return { totalDeleted: 0, totalRemaining, elapsedMs: 0 };
    }
    const startedAt = Date.now();
    const result = await this.artifactService.deleteByFilter({});
    const totalRemaining = (await this.artifactService.list({ limit: 1 })).total;
    return { totalDeleted: result.deletedIds.length, totalRemaining, elapsedMs: Date.now() - startedAt };
  }

  async rebuildArtifactIndex(): Promise<{ before: number; after: number; elapsedMs: number }> {
    const before = (await this.artifactService.list({ limit: 1 })).total;
    const startedAt = Date.now();
    await this.artifactMaintenance.rebuildIndex();
    const after = (await this.artifactService.list({ limit: 1 })).total;
    return { before, after, elapsedMs: Date.now() - startedAt };
  }

  // Phase 9.1: portfolio-wide, unlike every other method here — reuses
  // getRecommendations() once per registered repository (itself already
  // fetch-once per repository) rather than re-deriving any snapshot,
  // insight, or session data. Promise.allSettled() means one repository
  // failing to produce a report (e.g. an unreachable path) degrades that
  // repository out of the plan instead of aborting portfolio-wide planning
  // for every other repository — the same graceful-degradation precedent
  // RepositoryIntelligenceService already established for its own
  // multi-source fan-out. The pure AutonomousPlanningEngine only ever sees
  // the reports that actually succeeded.
  //
  // As of Phase 10, also the exact live-plan source recordAutonomousPlanCycle()
  // below reuses — no second, independent synthesis path exists anywhere in
  // this class.
  async getAutonomousPlan(): Promise<AutonomousPlan> {
    const repositories = this.repositoryRegistry.getAllRepositories();
    const settled = await Promise.allSettled(repositories.map((repository) => this.getRecommendations(repository.id)));
    const reports = settled
      .filter((outcome): outcome is PromiseFulfilledResult<RepositoryRecommendationReport> => outcome.status === "fulfilled")
      .map((outcome) => outcome.value);
    return this.autonomousPlanningEngine.buildPlan(reports);
  }

  // Phase 9.2 API, Phase 9.4 implementation: reuses
  // autonomousPlanningService.getRecentCycles() (one history fetch) and
  // extracts just the entries — still the exact same underlying
  // IAutonomousPlanHistoryService.getHistory() call this method always made,
  // just routed through the façade instead of holding that dependency
  // directly.
  async getAutonomousPlanHistory(limit?: number): Promise<AutonomousPlanHistoryEntry[]> {
    const cycles = await this.autonomousPlanningService.getRecentCycles(limit);
    return cycles.map((cycle) => cycle.entry);
  }

  // Phase 9.2 API, Phase 9.4 implementation: the most recent cycle's
  // already-baked-in evolution, read via getRecentCycles(1) rather than a
  // dedicated getLatestEntry() call — same data, one fewer method on the
  // façade's own surface. undefined only when no cycle has ever been
  // recorded yet.
  async getLatestAutonomousPlanEvolution(): Promise<AutonomousPlanEvolutionReport | undefined> {
    const [latest] = await this.autonomousPlanningService.getRecentCycles(1);
    return latest?.entry.evolution;
  }

  // Phase 9.3 API, Phase 9.4 implementation: reuses the same
  // getRecentCycles() fetch-once-and-derive as getAutonomousPlanHistory()
  // above, extracting the derived state instead of the raw entry — entry
  // and state for a given cycle always come from the same underlying fetch,
  // never two independent reads that could disagree.
  async getAutonomousPlanStates(limit?: number): Promise<AutonomousPlanState[]> {
    const cycles = await this.autonomousPlanningService.getRecentCycles(limit);
    return cycles.map((cycle) => cycle.state);
  }

  // Phase 9.3 API, Phase 9.4 implementation: pure delegation to the façade's
  // own lightweight, single-entry-fetch method — no full cycle window is
  // derived just to answer "what's current right now."
  async getCurrentPlanState(): Promise<AutonomousPlanState | undefined> {
    return this.autonomousPlanningService.getCurrentPlanState();
  }

  // Phase 9.3 API, Phase 9.4 implementation: fetches the live plan (Phase
  // 9.1, unchanged) exactly once, then reuses getAutonomousPlanningSnapshot()'s
  // own underlying call for the comparison rather than a second, independent
  // façade method.
  async getLivePlanComparison(): Promise<LivePlanComparison> {
    const livePlan = await this.getAutonomousPlan();
    const snapshot = await this.autonomousPlanningService.getPlanningStatus(livePlan);
    return snapshot.comparison;
  }

  // Phase 9.4: the composed view getLivePlanComparison() above already
  // partially exposes — fetches the live plan once, hands it to
  // autonomousPlanningService.getPlanningStatus(), which itself fetches the
  // active entry exactly once and derives both currentState and comparison
  // from that same fetch, so the two can never describe different instants.
  async getAutonomousPlanningSnapshot(): Promise<AutonomousPlanningSnapshot> {
    const livePlan = await this.getAutonomousPlan();
    return this.autonomousPlanningService.getPlanningStatus(livePlan);
  }

  // Phase 9.5: pure delegation, no orchestration — AutonomousPlanningService
  // owns fetching the recent-cycles window and invoking the analysis engine
  // itself (see its getAnalysis() doc comment); this class does not regain
  // planning-specific orchestration responsibility for this method any more
  // than it holds one for the other four Autonomous Planning queries above.
  async getAutonomousPlanAnalysis(limit?: number): Promise<AutonomousPlanAnalysisReport> {
    return this.autonomousPlanningService.getAnalysis(limit);
  }

  // Phase 9.6: the one place the Planning domain and the Readiness domain
  // meet. Fetches the live plan exactly once, then fetches the snapshot
  // (which reuses that same live plan) and the analysis window concurrently
  // — both are independent reads from AutonomousPlanningService's own
  // fetch-once-internally methods, so there is nothing to further
  // deduplicate here — and hands both results to the pure
  // AutonomousPlanReadinessEngine. Never touches record(), never reaches
  // ControllerCore/ExecutionPipeline/ApprovalEngine — there is no
  // dependency here capable of any of that.
  async getAutonomousPlanReadiness(limit?: number): Promise<AutonomousPlanReadinessReport> {
    const livePlan = await this.getAutonomousPlan();
    const [snapshot, analysis] = await Promise.all([
      this.autonomousPlanningService.getPlanningStatus(livePlan),
      this.autonomousPlanningService.getAnalysis(limit),
    ]);
    return this.readinessEngine.assess(snapshot, analysis);
  }

  // Phase 9.7: the one place the Readiness domain and the Plan Sequencing
  // domain meet. Fetches the readiness report exactly once (itself already
  // fetch-once internally) and hands it to the pure
  // AutonomousPlanSequencingEngine — never a second, independent readiness
  // fetch. Purely descriptive: an ordering fact, never a timing, cadence,
  // approval, eligibility, or execution decision.
  async getAutonomousPlanSequence(limit?: number): Promise<AutonomousPlanSequencingReport> {
    const readiness = await this.getAutonomousPlanReadiness(limit);
    return this.sequencingEngine.sequence(readiness);
  }

  // Phase 9.8: the one place the Plan Sequencing domain and the Scheduling
  // domain meet. Fetches the sequence report exactly once (itself already
  // fetch-once internally) and hands it to the pure
  // AutonomousPlanSchedulingEngine — never a second, independent sequence
  // fetch. Purely a cadence classification: never a duration, interval,
  // timer, approval, eligibility, or execution decision.
  async getAutonomousPlanSchedule(limit?: number): Promise<AutonomousPlanSchedulingReport> {
    const sequence = await this.getAutonomousPlanSequence(limit);
    return this.schedulingEngine.schedule(sequence);
  }

  // Phase 10: the first write operation this class performs anywhere —
  // every method above this one, and every method below it, only ever
  // reads. Fetches the live plan via getAutonomousPlan() (the exact same
  // call every other Autonomous Planning method reuses, no second synthesis
  // path), then hands it to AutonomousPlanRecordingService, which owns the
  // rest of the write itself. This class never touches
  // IAutonomousPlanHistoryService directly — the write is delegated in
  // full, not partially performed here.
  async recordAutonomousPlanCycle(): Promise<AutonomousPlanHistoryEntry> {
    const livePlan = await this.getAutonomousPlan();
    return this.recordingService.recordAutonomousPlanCycle(livePlan);
  }

  private resolveRepositoryId(repositoryId?: string): string {
    if (repositoryId) {
      return repositoryId;
    }
    const activeRepository = this.repositoryRegistry.getActiveRepository();
    if (!activeRepository) {
      throw new NoActiveRepositoryError();
    }
    return activeRepository.id;
  }
}
