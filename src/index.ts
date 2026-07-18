import { existsSync } from "node:fs";
import path from "node:path";
import { DeferredRuntimeAdministrationService, RuntimeAdministrationService } from "./admin";
import { ApplicationService } from "./application";
import { ApprovalEngine } from "./approval";
import { AttentionDispatcher } from "./attention";
import { EngineeringAssistanceEngine } from "./assistance";
import { AutonomousPlanningEngine } from "./autonomy";
import { ContextBuilder } from "./context";
import { ExecutionCoordinator } from "./coordination";
import { ControllerCore, DeferredControllerCore } from "./controller";
import { ConfigService } from "./config";
import { DeferredRuntimeControlService, RuntimeControlService } from "./control";
import { DecisionEngine } from "./decisions";
import { RuntimeDiagnosticsEngine } from "./diagnostics";
import { RepositoryIntelligenceService } from "./intelligence";
import { MemoryRecordingControllerCore, ProjectMemoryService } from "./memory";
import { ProactiveMonitor, RecommendationStateStore } from "./monitoring";
import { TaskPlanner, WorkflowFactory } from "./planner";
import { AutonomousPlanEvolutionEngine, AutonomousPlanHistoryService } from "./planhistory";
import { AutonomousPlanningAnalysisEngine } from "./plananalysis";
import { AutonomousPlanningService } from "./plan";
import { AutonomousPlanReadinessEngine } from "./planreadiness";
import { AutonomousPlanRecordingService } from "./planrecording";
import { AutonomousExecutionOrchestrator } from "./autonomousexecution";
import type { IAutonomousExecutionOrchestrator } from "./autonomousexecution";
import { AutonomousPlanSequencingEngine } from "./plansequencing";
import { AutonomousPlanStateEngine } from "./planstate";
import { AutonomousPlanSchedulingEngine } from "./scheduling";
import { ExecutionPipeline } from "./pipeline";
import { PlanningEngine } from "./planning";
import { WorkflowOrchestrator, WorkflowRegistry } from "./orchestration";
import { RuntimePolicyEngine } from "./policy";
import { RecommendationEngine } from "./recommendations";
import { RepositoryRegistry } from "./repositories";
import { RuntimeReportingEngine } from "./reporting";
import { AutonomousExecutionWorker, AutonomousPlanRecordingWorker, BackgroundRuntime, HealthCheckWorker, MonitoringWorker } from "./runtime";
import { ClaudeSessionManager } from "./session";
import { EnvironmentValidator } from "./startup";
import { DeferredRuntimeStatusService, RuntimeStatusService } from "./status";
import { StrategyEngine } from "./strategy";
import {
  NotifyingAutonomousExecutionOrchestrator,
  ResponseFormatter,
  TelegramAdapter,
  TelegramApiClient,
  TelegramApprovalProvider,
  TelegramAttentionTransport,
  TelegramLongPoller,
  TelegramSecurity,
  buildTelegramCorrelationId,
} from "./telegram";

function loadEnvFile(): void {
  const envFilePath = path.resolve(__dirname, "../.env");
  if (existsSync(envFilePath)) {
    process.loadEnvFile(envFilePath);
  }
}

async function bootstrap(): Promise<void> {
  loadEnvFile();

  const configService = new ConfigService();

  // Stage 4 (operational hardening): a pure, advisory prerequisite check —
  // every issue it can report is a warning, never fatal, and it never
  // changes what happens next. Run once, here, before anything else is
  // built, so a missing CLI or an unwritable memory directory is visible in
  // the very first lines of startup output instead of surfacing later as a
  // confusing failure deep inside a specific workflow.
  const environmentValidator = new EnvironmentValidator(configService);
  const environmentReport = await environmentValidator.validate();
  for (const issue of environmentReport.issues) {
    console.warn(`environment-validator: [${issue.check}] ${issue.message}`);
  }

  const repositoryRegistry = new RepositoryRegistry(configService);

  // Repository Intelligence / Project Memory / Session Manager / Decision Engine
  // / Context Builder (Phases 6.1-6.5) don't depend on the execution stack at
  // all, so they're built first — both the recording decorator and
  // WorkflowFactory's session-aware Claude wiring below need the session
  // manager already constructed. DecisionEngine and ContextBuilder no longer
  // take IRepositoryIntelligenceService: they reason about whichever
  // RepositorySnapshot their caller passes them (ApplicationService below,
  // or StrategyEngine as part of a shared PipelineContext) rather than
  // fetching their own.
  const repositoryIntelligence = new RepositoryIntelligenceService(repositoryRegistry, configService);
  const projectMemory = new ProjectMemoryService(repositoryRegistry, configService);
  const sessionManager = new ClaudeSessionManager();
  const decisionEngine = new DecisionEngine(projectMemory, sessionManager);
  const contextBuilder = new ContextBuilder(projectMemory);
  // RecommendationEngine (Phase 7.6) is a pure synthesis step, same shape as
  // PlanningEngine/ExecutionCoordinator: no constructor dependencies, no I/O.
  // ApplicationService fetches the snapshot/insights/session exactly once
  // each and hands them in — it never gives RecommendationEngine a way to
  // recompute or duplicate what those already produced.
  const recommendationEngine = new RecommendationEngine();
  // EngineeringAssistanceEngine (Phase 7.8) is likewise a pure transform: it
  // only relabels an already-computed RepositoryRecommendationReport into
  // engineering-oriented suggested actions, never recomputing a
  // recommendation itself.
  const engineeringAssistanceEngine = new EngineeringAssistanceEngine();
  // Phase 8.5: ApplicationService needs an IRuntimeStatusService at
  // construction time, but the real RuntimeStatusService can only be built
  // once the Background Runtime cluster below exists — and that cluster's
  // ProactiveMonitor needs this exact applicationService instance first (a
  // real construction-time cycle, not a hypothetical one; see
  // DeferredRuntimeStatusService's own doc comment for the full trace).
  // deferredRuntimeStatusService is the seam: bound below, once the real
  // RuntimeStatusService is known — identical pattern to
  // DeferredControllerCore elsewhere in this file.
  const deferredRuntimeStatusService = new DeferredRuntimeStatusService();
  // Phase 8.8: unlike the three Deferred* seams in this file,
  // RuntimeDiagnosticsEngine has zero constructor dependencies of its own —
  // a pure transform, like PlanningEngine/ExecutionCoordinator/
  // RecommendationEngine — so it can be constructed here directly, with no
  // ordering constraint and no seam needed at all.
  const runtimeDiagnosticsEngine = new RuntimeDiagnosticsEngine();
  // Phase 8.9: same shape as runtimeDiagnosticsEngine above — zero
  // constructor dependencies, no ordering constraint, no seam needed.
  const runtimeReportingEngine = new RuntimeReportingEngine();
  // Phase 9.1: same shape as recommendationEngine/engineeringAssistanceEngine
  // above — zero constructor dependencies, no ordering constraint, no seam
  // needed. Deliberately not passed to, or wired into, BackgroundRuntime,
  // MonitoringWorker, ExecutionPipeline, ControllerCore, or Telegram
  // anywhere in this file — Autonomous Planning stays reachable only through
  // ApplicationService.getAutonomousPlan(), which nothing calls yet.
  const autonomousPlanningEngine = new AutonomousPlanningEngine();
  // Phase 9.2: AutonomousPlanEvolutionEngine is a pure transform, same shape
  // as autonomousPlanningEngine above — zero constructor dependencies, no
  // ordering constraint, no seam needed. AutonomousPlanHistoryService is a
  // real dependency (disk I/O via configService, reused for
  // ControllerConfig.memory.directory the same way ProjectMemoryService is,
  // under a distinct file) but has no ordering constraint either: it depends
  // only on configService and autonomousPlanEvolutionEngine, both already
  // built. As of Phase 10, its record() method is reachable — via
  // autonomousPlanRecordingService below, itself reached only through
  // ApplicationService.recordAutonomousPlanCycle() — but nothing in this
  // file calls that method; deciding when a planning cycle should actually
  // be recorded on an ongoing basis is still left to a future
  // runtime/scheduler phase, not to bootstrap.
  const autonomousPlanEvolutionEngine = new AutonomousPlanEvolutionEngine();
  const autonomousPlanHistoryService = new AutonomousPlanHistoryService(configService, autonomousPlanEvolutionEngine);
  // Phase 9.3: AutonomousPlanStateEngine derives plan state purely from
  // AutonomousPlanHistoryEntry data ApplicationService already fetches — it
  // holds no state of its own (deriveStates() recomputes fresh from
  // whatever window it's given every call) and reuses
  // autonomousPlanEvolutionEngine (already built above) for its
  // compareToActive() hypothetical-comparison method, rather than
  // constructing a second instance. No ordering constraint, no seam needed.
  const autonomousPlanStateEngine = new AutonomousPlanStateEngine(autonomousPlanEvolutionEngine);
  // Phase 9.5: AutonomousPlanningAnalysisEngine is a pure transform, same
  // shape as autonomousPlanStateEngine/autonomousPlanEvolutionEngine above —
  // zero constructor dependencies, no ordering constraint, no seam needed.
  // Constructed here, before the façade below, since the façade now takes it
  // as a constructor dependency (it owns invoking the analysis engine
  // itself, not ApplicationService).
  const autonomousPlanningAnalysisEngine = new AutonomousPlanningAnalysisEngine();
  // Phase 9.4 (extended in 9.5): the consumer-facing façade over the
  // recorded-planning domain (autonomousPlanHistoryService +
  // autonomousPlanStateEngine + autonomousPlanningAnalysisEngine, all
  // already built above) — ApplicationService depends on this one instance
  // instead of wiring any of the three individually itself. No ordering
  // constraint, no seam needed: all three dependencies already exist.
  const autonomousPlanningService = new AutonomousPlanningService(
    autonomousPlanHistoryService,
    autonomousPlanStateEngine,
    autonomousPlanningAnalysisEngine,
  );
  // Phase 9.6: AutonomousPlanReadinessEngine is a pure transform, same shape
  // as every other engine above — zero constructor dependencies, no
  // ordering constraint, no seam needed. Deliberately NOT a constructor
  // dependency of autonomousPlanningService above (a new, separate domain,
  // not part of the Planning façade) — ApplicationService is the only place
  // this engine and autonomousPlanningService meet, via
  // getAutonomousPlanReadiness()'s own cross-domain composition.
  const autonomousPlanReadinessEngine = new AutonomousPlanReadinessEngine();
  // Phase 9.7: AutonomousPlanSequencingEngine is a pure transform, same
  // shape as every other engine above — zero constructor dependencies, no
  // ordering constraint, no seam needed. Deliberately NOT a constructor
  // dependency of autonomousPlanReadinessEngine above (a new, separate
  // domain, not part of Readiness) — ApplicationService is the only place
  // this engine and autonomousPlanReadinessEngine meet, via
  // getAutonomousPlanSequence()'s own cross-domain composition.
  const autonomousPlanSequencingEngine = new AutonomousPlanSequencingEngine();
  // Phase 9.8: AutonomousPlanSchedulingEngine is a pure transform, same
  // shape as every other engine above — zero constructor dependencies, no
  // ordering constraint, no seam needed. Deliberately NOT a constructor
  // dependency of autonomousPlanSequencingEngine above (a new, separate
  // domain, not part of Plan Sequencing) — ApplicationService is the only
  // place this engine and autonomousPlanSequencingEngine meet, via
  // getAutonomousPlanSchedule()'s own cross-domain composition.
  const autonomousPlanSchedulingEngine = new AutonomousPlanSchedulingEngine();
  // Phase 10: AutonomousPlanRecordingService reuses this exact same
  // autonomousPlanHistoryService instance built above for Phase 9.2 — no
  // second instance, no second file, no new resource. Deliberately not a
  // constructor dependency of autonomousPlanningService (the read façade) —
  // it is that façade's sibling on the write side, meeting it only inside
  // ApplicationService.recordAutonomousPlanCycle(). No ordering constraint,
  // no seam needed: its one dependency already exists.
  const autonomousPlanRecordingService = new AutonomousPlanRecordingService(autonomousPlanHistoryService);
  // Phase 8.6: same ordering problem, same seam shape — RuntimeControlService
  // needs the real IBackgroundRuntime, which (via MonitoringWorker ->
  // ProactiveMonitor) needs this exact applicationService instance to exist
  // first. See DeferredRuntimeControlService's own doc comment for the full
  // trace.
  const deferredRuntimeControlService = new DeferredRuntimeControlService();
  // Phase 8.7: same ordering problem, same seam shape —
  // RuntimeAdministrationService needs the real IRuntimeStatusService/
  // IRuntimeControlService/IRuntimePolicyEngine, all of which need this
  // exact applicationService instance to exist first (transitively, via
  // MonitoringWorker -> ProactiveMonitor). See
  // DeferredRuntimeAdministrationService's own doc comment for the full
  // trace.
  const deferredRuntimeAdministrationService = new DeferredRuntimeAdministrationService();
  const applicationService = new ApplicationService(
    repositoryIntelligence,
    projectMemory,
    decisionEngine,
    sessionManager,
    repositoryRegistry,
    recommendationEngine,
    engineeringAssistanceEngine,
    deferredRuntimeStatusService,
    runtimeDiagnosticsEngine,
    runtimeReportingEngine,
    deferredRuntimeControlService,
    deferredRuntimeAdministrationService,
    autonomousPlanningEngine,
    autonomousPlanningService,
    autonomousPlanReadinessEngine,
    autonomousPlanSequencingEngine,
    autonomousPlanSchedulingEngine,
    autonomousPlanRecordingService,
  );

  // Strategy Engine / Planning Engine / Execution Coordinator (Phases 7.1-7.3)
  // are the autonomous decision-support stack: Task -> TaskExecutionStrategy
  // -> ExecutionPlan -> CapabilityProgram. None of them execute anything —
  // ExecutionPipeline below is what finally turns a CapabilityProgram into
  // real ControllerCore calls.
  //
  // Phase 13: moved up from its original position (originally built after
  // the Background Runtime cluster below) so that executionPipeline exists
  // in time for AutonomousExecutionOrchestrator/AutonomousExecutionWorker to
  // be constructed before backgroundRuntime — a real ordering requirement,
  // not a stylistic one: BackgroundRuntime's own worker array is fixed at
  // construction time, and AutonomousExecutionWorker (below) needs a real
  // orchestrator, which needs a real executionPipeline. Nothing in this
  // block ever depended on anything in the Background Runtime cluster
  // (runtimePolicyEngine/proactiveMonitor/attentionDispatcher/
  // monitoringWorker/backgroundRuntime) — the two clusters are, and always
  // were, independent subgraphs that merely happened to be written in this
  // file in the other order.
  const strategyEngine = new StrategyEngine(decisionEngine, contextBuilder, sessionManager);
  const planningEngine = new PlanningEngine();
  const executionCoordinator = new ExecutionCoordinator();

  const workflowFactory = new WorkflowFactory(configService, repositoryRegistry, sessionManager);
  const taskPlanner = new TaskPlanner(configService, workflowFactory);

  // WorkflowOrchestrator needs "the top-of-stack IControllerCore" (plain, or
  // ApprovalEngine-wrapped, now also memory-recording) so every step it runs
  // still passes through approval and gets recorded — but that instance
  // doesn't exist yet until after ControllerCore (which needs the
  // orchestrator) is built. DeferredControllerCore is the seam: bound below,
  // once the real entry point is known. ExecutionPipeline is given this same
  // seam, not a later concrete instance, so it resolves correctly regardless
  // of whether Telegram ends up enabled below — identical to how
  // WorkflowOrchestrator already depends on it.
  const controllerEntryPoint = new DeferredControllerCore();
  const workflowRegistry = new WorkflowRegistry();
  const workflowOrchestrator = new WorkflowOrchestrator(controllerEntryPoint, workflowRegistry);
  const executionPipeline = new ExecutionPipeline(
    repositoryIntelligence,
    strategyEngine,
    planningEngine,
    executionCoordinator,
    controllerEntryPoint,
  );

  const plainControllerCore = new ControllerCore(repositoryRegistry, taskPlanner, workflowOrchestrator);

  // Phase 14: fetched here — earlier than telegramConfig was previously
  // read in this file (it used to be read only inside the telegram.enabled
  // check below, which is reused as-is further down rather than re-fetched
  // a second time) — because AutonomousExecutionWorker (in the Background
  // Runtime cluster below) needs operatorCorrelationId before it is
  // constructed. Reading config is a pure, side-effect-free operation
  // regardless of whether Telegram ends up enabled, so this is safe to do
  // unconditionally, this early. operator_chat_id is optional: absent ->
  // operatorCorrelationId is undefined -> AutonomousExecutionWorker behaves
  // exactly as it did in Phase 13.
  //
  // Phase 15: telegramClient and telegramSecurity are, for the same reason,
  // now also constructed here rather than only inside the telegram.enabled
  // branch (where they used to be built and are reused, not rebuilt, below)
  // — NotifyingAutonomousExecutionOrchestrator needs a real ITelegramClient
  // before AutonomousExecutionWorker is constructed. Both classes' own
  // constructors are trivial, side-effect-free wrappers around configService
  // (no network call, no env var read, no eager validation) — confirmed
  // safe to construct unconditionally, the same way telegramConfig itself
  // already is.
  const telegramConfig = configService.getTelegramConfig();
  const operatorChatId = telegramConfig.telegram.operator_chat_id;
  const operatorCorrelationId = operatorChatId !== undefined ? buildTelegramCorrelationId(operatorChatId, 0) : undefined;
  const telegramClient = new TelegramApiClient(configService);
  const telegramSecurity = new TelegramSecurity(configService);
  const responseFormatter = new ResponseFormatter();

  // Phase 11 (extended in Phase 12/13/15): the first, and now the third,
  // execution-capable component's shared entry point. Reuses this exact
  // applicationService and executionPipeline instance — no new resource, no
  // new ordering constraint. Constructed once, here, and reused by both
  // TelegramAdapter (inside the telegram.enabled branch below) and
  // AutonomousExecutionWorker (in the Background Runtime cluster
  // immediately below) rather than each building its own instance.
  //
  // Phase 15: when operatorChatId is configured, this is instead the
  // NotifyingAutonomousExecutionOrchestrator decorator — same interface,
  // same downstream usage by both consumers, the wrapped
  // AutonomousExecutionOrchestrator itself completely unchanged either way.
  // The decision is made exactly once, here; nothing downstream needs to
  // know which concrete implementation it received.
  const autonomousExecutionOrchestrator: IAutonomousExecutionOrchestrator =
    operatorChatId !== undefined
      ? new NotifyingAutonomousExecutionOrchestrator(
          new AutonomousExecutionOrchestrator(applicationService, executionPipeline),
          telegramClient,
          responseFormatter,
          operatorChatId,
        )
      : new AutonomousExecutionOrchestrator(applicationService, executionPipeline);

  // Background Runtime cluster (Phase 8.2, extended in Phase 8.3, gated by
  // policy in Phase 8.4; a second worker added in Phase 10.1, a third in
  // Phase 13): RuntimePolicyEngine, ProactiveMonitor, AttentionDispatcher,
  // MonitoringWorker, AutonomousPlanRecordingWorker, AutonomousExecutionWorker,
  // and BackgroundRuntime are constructed and started together, immediately
  // after the read-only intelligence cluster and the execution stack above
  // (both now already built) they depend on, rather than scattered across
  // bootstrap — they are one unit of composition. None of them depend on
  // Telegram, and BackgroundRuntime's lifecycle (start here, stop in the
  // shared shutdown handler at the bottom of this function) is intentionally
  // independent of whether Telegram ends up enabled: monitoring, recording,
  // and autonomous execution must keep running whether or not any transport
  // is active. MonitoringWorker stays read-only — its dependencies are
  // IProactiveMonitor, IRepositoryRegistry, IAttentionDispatcher, and
  // IRuntimePolicyEngine, none of which can execute a Task/workflow or reach
  // ControllerCore/ExecutionPipeline.
  //
  // RuntimePolicyEngine is constructed with its internal defaults (quiet
  // hours, per-repository cooldown, global notification-per-interval limit —
  // see src/policy/types.ts) — no YAML configuration exists for it, same
  // "kept internal for now" precedent as DecisionEngine's thresholds and
  // monitoring's own MonitoringPolicy. It is shared, as the same instance,
  // between MonitoringWorker (gating evaluation) and AttentionDispatcher
  // (gating delivery) — the one place in this file where both halves of
  // Phase 8.4's governance meet.
  //
  // AttentionDispatcher starts with zero transports registered — it is built
  // here, before Telegram's own collaborators exist (those are constructed
  // conditionally, later, inside the telegram.enabled branch below) — and a
  // TelegramAttentionTransport is registered into this exact same instance
  // further down only if that branch is reached. MonitoringWorker never sees
  // this registration happen and never knows Telegram exists either way: it
  // only ever calls dispatch() on the IAttentionDispatcher abstraction.
  //
  // Phase 10.1: AutonomousPlanRecordingWorker is passed this exact same
  // applicationService instance (already built above), but typed against
  // IAutonomousPlanCycleRecorder — the narrow, single-method view carved out
  // of IApplicationService specifically so this worker has no dependency
  // capable of reaching getRuntimeControl()/getRuntimeAdministration()/any
  // other IApplicationService surface, matching MonitoringWorker's own "no
  // dependency capable of X, by construction" guarantee. No change to
  // ApplicationService itself was needed — it already implements the one
  // method the narrow interface requires.
  //
  // Phase 13 (extended in Phase 14): AutonomousExecutionWorker is passed
  // applicationService typed as IAutonomousPlanScheduleProvider,
  // projectMemory typed as IRecentExecutionHistoryProvider (never the full
  // IProjectMemoryService — this worker must never call record() itself,
  // since every execution it triggers is already recorded automatically
  // further up the MemoryRecordingControllerCore-wrapped stack once
  // Telegram is enabled), and the autonomousExecutionOrchestrator instance
  // built above. operatorCorrelationId (computed just above) is forwarded
  // as-is — when undefined (operator_chat_id not configured), this worker
  // behaves exactly as Phase 13 built it: no correlationId ever reaches
  // attemptExecution(), so any approval-gated step downstream is denied by
  // TelegramApprovalProvider's own existing, unmodified logic. When
  // configured, the exact same denial logic instead finds a real chat to
  // route the prompt to. Either way, this worker never inspects or
  // interprets the value itself — it is an opaque string, exactly like
  // PipelineRequest.correlationId already is everywhere else in this stack.
  const runtimePolicyEngine = new RuntimePolicyEngine();
  // Explicitly constructed (rather than left to ProactiveMonitor's own
  // default parameter) so configService can be passed through, giving this
  // store restart-durable delivery tracking — see RecommendationStateStore's
  // own doc comment. restore() is awaited below, before backgroundRuntime
  // (and therefore MonitoringWorker's first tick) starts, so a still-active
  // recommendation from a prior process lifetime is never re-announced as
  // new just because the process restarted.
  const recommendationStateStore = new RecommendationStateStore(undefined, configService);
  await recommendationStateStore.restore();
  const proactiveMonitor = new ProactiveMonitor(applicationService, undefined, recommendationStateStore);
  const attentionDispatcher = new AttentionDispatcher(runtimePolicyEngine);
  const monitoringWorker = new MonitoringWorker(
    proactiveMonitor,
    repositoryRegistry,
    attentionDispatcher,
    runtimePolicyEngine,
  );
  const autonomousPlanRecordingWorker = new AutonomousPlanRecordingWorker(applicationService);
  const autonomousExecutionWorker = new AutonomousExecutionWorker(
    applicationService,
    projectMemory,
    autonomousExecutionOrchestrator,
    undefined,
    operatorCorrelationId,
  );
  // Stage 4 (operational hardening): a liveness heartbeat, not a business
  // capability — see HealthCheckWorker's own doc comment. Depends only on
  // configService, so it carries none of the "no dependency capable of X"
  // constraints the other three workers document; it has no dependency
  // capable of anything execution-related in the first place.
  const healthCheckWorker = new HealthCheckWorker(configService);
  const backgroundRuntime = new BackgroundRuntime([
    monitoringWorker,
    autonomousPlanRecordingWorker,
    autonomousExecutionWorker,
    healthCheckWorker,
  ]);
  backgroundRuntime.start();

  // Phase 8.5: the real RuntimeStatusService can only be built now that
  // every collaborator it reports on exists — it is a pure read-only
  // composition over their own getStatus() methods, with no state or logic
  // of its own. Binding it here closes the deferred seam opened above,
  // before any request that could call ApplicationService.getRuntimeStatus()
  // can possibly flow in.
  const runtimeStatusService = new RuntimeStatusService(
    backgroundRuntime,
    monitoringWorker,
    attentionDispatcher,
    runtimePolicyEngine,
  );
  deferredRuntimeStatusService.bind(runtimeStatusService);

  // Phase 8.6: RuntimeControlService is pure orchestration over the same
  // three collaborators already built above (runtimePolicyEngine,
  // backgroundRuntime, attentionDispatcher) — no new state, no new
  // execution capability. Binding it here closes the second deferred seam
  // opened above, before any request that could reach
  // ApplicationService.getRuntimeControl() can possibly flow in.
  const runtimeControlService = new RuntimeControlService(runtimePolicyEngine, backgroundRuntime, attentionDispatcher);
  deferredRuntimeControlService.bind(runtimeControlService);

  // Phase 8.7: RuntimeAdministrationService is a pure composition facade
  // over the same runtimeStatusService/runtimeControlService/runtimePolicyEngine
  // instances already built and bound above — no new state, no new
  // execution capability, no reconstruction of RuntimeStatus or
  // RuntimePolicyStatus. Binding it here closes the third deferred seam
  // opened above, before any request that could reach
  // ApplicationService.getRuntimeAdministration() can possibly flow in.
  const runtimeAdministrationService = new RuntimeAdministrationService(
    runtimeStatusService,
    runtimeControlService,
    runtimePolicyEngine,
  );
  deferredRuntimeAdministrationService.bind(runtimeAdministrationService);

  const controllerConfig = configService.getControllerConfig();
  const repositories = repositoryRegistry.getAllRepositories();

  console.log(`${controllerConfig.controller.name} v${controllerConfig.controller.version} started.`);
  console.log(
    `Registered repositories: ${repositories.length === 0 ? "none" : repositories.map((repo) => repo.id).join(", ")}`,
  );

  // Hoisted so the single shutdown handler below can reach it regardless of
  // which branch runs — assigned only in the Telegram-enabled branch, left
  // undefined in the disabled one. BackgroundRuntime's own shutdown does not
  // depend on this either way (see below).
  let poller: TelegramLongPoller | undefined;

  // Stage 4 (operational hardening): poller.stop()/backgroundRuntime.stop()
  // are unchanged and still run first, exactly as before — this only adds a
  // bounded upper bound on top of them. Without it, a pending Telegram
  // approval (TelegramApprovalProvider's own un-unref'd timeout, up to
  // APPROVAL_TIMEOUT_MINUTES) or an in-flight Claude call
  // (ClaudeAdapter's own un-unref'd execution timeout, up to
  // ClaudeConfig.execution.max_execution_minutes) can each independently
  // keep the process alive for several more minutes after both stop() calls
  // above have already returned, since neither of those timers is touched by
  // shutdown() and Node won't exit while a ref'd timer is still pending. A
  // process supervisor's own SIGKILL grace period would eventually end this
  // anyway (uncontrolled); this makes the same outcome controlled, logged,
  // and bounded by this process's own clock instead. GRACEFUL_SHUTDOWN_TIMEOUT_MS
  // is intentionally shorter than typical supervisor SIGKILL grace periods
  // (Docker/PM2 commonly default around 10s+, Kubernetes 30s) so this always
  // gets a chance to log before anything more forceful happens — see
  // ecosystem.config.js's kill_timeout, which must stay comfortably above
  // this value.
  //
  // unref()'d deliberately: in the common case (nothing pending), the
  // process still exits immediately once poller.stop()/backgroundRuntime.stop()
  // finish and the event loop naturally drains — this timer never adds delay
  // to a clean shutdown, it only fires if something else is genuinely still
  // keeping the process alive when its time comes.
  const GRACEFUL_SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10_000;
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`${signal} received — shutting down (up to ${GRACEFUL_SHUTDOWN_TIMEOUT_MS}ms grace period)...`);
    poller?.stop();
    backgroundRuntime.stop();
    const forceExitTimer = setTimeout(() => {
      console.error(
        `Graceful shutdown did not complete within ${GRACEFUL_SHUTDOWN_TIMEOUT_MS}ms (a pending Telegram approval or an in-flight Claude call is the likely cause) — forcing exit.`,
      );
      process.exit(1);
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  // telegramClient and telegramSecurity were already constructed above
  // (Phase 15), before the Background Runtime cluster -- reused here rather
  // than built a second time.
  //
  // telegramApprovalProvider/approvalControllerCore/controllerCore are built
  // and bound to controllerEntryPoint unconditionally, before the
  // telegram.enabled check below — not only inside the (formerly
  // Telegram-only) branch that used to build them. BackgroundRuntime's
  // AutonomousExecutionWorker (started above, before this point) reaches
  // ControllerCore through this exact same controllerEntryPoint seam and
  // runs whether or not Telegram itself is enabled (see the Background
  // Runtime cluster comment above) — so the approval gate configured in
  // ControllerConfig.approval (e.g. require_before_git_push) must be in
  // effect on this seam unconditionally too, or a mutating action taken
  // while Telegram is disabled would bypass it entirely. This does not
  // require a live long-poller to be safe: TelegramApprovalProvider already
  // fails closed on its own — immediately, if the request's correlationId
  // isn't Telegram-shaped (the case whenever operator_chat_id isn't
  // configured, exactly as AutonomousExecutionWorker's own doc comment
  // describes), or after its own timeout otherwise.
  const telegramApprovalProvider = new TelegramApprovalProvider(telegramClient, telegramSecurity);
  const approvalControllerCore = new ApprovalEngine(plainControllerCore, configService, telegramApprovalProvider);
  // Recording wraps the outermost layer (above approval) so every execution
  // that crosses it — standalone tasks, whole workflows, and each individual
  // workflow step re-entering via controllerEntryPoint — gets a Project
  // Memory event, without ControllerCore/ApprovalEngine/WorkflowOrchestrator
  // changing at all. A recording failure is swallowed inside the decorator
  // itself (Phase 6.2), so it can never affect the real result below.
  const controllerCore = new MemoryRecordingControllerCore(approvalControllerCore, projectMemory);
  controllerEntryPoint.bind(controllerCore);

  // telegramConfig was already fetched above (Phase 14), before the
  // Background Runtime cluster -- reused here rather than fetched a second
  // time. Telegram being disabled only means the long-polling transport and
  // its adapter never start — it no longer implies an unapproved
  // ControllerCore, which is why the binding above happens unconditionally.
  if (!telegramConfig.telegram.enabled) {
    console.log("Telegram transport disabled (telegram.enabled = false in config/telegram.yaml).");
    return;
  }

  // Registers this exact same attentionDispatcher (built above, before this
  // branch was known to be reached) with its one Telegram-specific transport
  // — the only place in this file where the attention-delivery cluster and
  // Telegram meet. AttentionDispatcher itself is unaware this happened.
  attentionDispatcher.addTransport(new TelegramAttentionTransport(telegramClient, configService));

  // ExecutionPipeline is now the single runtime entrypoint Telegram submits
  // engineering task execution requests to (Phase 7.5) — it was built above
  // against controllerEntryPoint, so it transparently reaches this same
  // fully-decorated controllerCore (approval-gated, memory-recording) now
  // that binding has happened, identical to how WorkflowOrchestrator does.
  // Phase 12 (rewired in Phase 13, extended in Phase 15): reuses the exact
  // same autonomousExecutionOrchestrator instance built earlier in this
  // function (Phase 13 moved its construction above the Background Runtime
  // cluster, since AutonomousExecutionWorker now also needs it) —
  // TelegramAdapter and AutonomousExecutionWorker share one orchestrator
  // instance, not two, whether or not it is the Phase 15 notifying variant.
  // responseFormatter is likewise the same shared instance built above
  // (also used by NotifyingAutonomousExecutionOrchestrator, if constructed)
  // rather than each collaborator building its own.
  const telegramAdapter = new TelegramAdapter(
    executionPipeline,
    applicationService,
    telegramSecurity,
    telegramClient,
    autonomousExecutionOrchestrator,
    undefined,
    responseFormatter,
  );
  poller = new TelegramLongPoller(telegramClient, telegramAdapter, telegramApprovalProvider);

  console.log("Telegram transport enabled, starting long polling.");
  await poller.start();
}

bootstrap().catch((error) => {
  console.error("Failed to start AI Controller:", error instanceof Error ? error.message : error);
  process.exit(1);
});
