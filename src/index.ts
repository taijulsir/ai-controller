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
import { ProactiveMonitor } from "./monitoring";
import { TaskPlanner, WorkflowFactory } from "./planner";
import { AutonomousPlanEvolutionEngine, AutonomousPlanHistoryService } from "./planhistory";
import { AutonomousPlanningService } from "./plan";
import { AutonomousPlanStateEngine } from "./planstate";
import { ExecutionPipeline } from "./pipeline";
import { PlanningEngine } from "./planning";
import { WorkflowOrchestrator, WorkflowRegistry } from "./orchestration";
import { RuntimePolicyEngine } from "./policy";
import { RecommendationEngine } from "./recommendations";
import { RepositoryRegistry } from "./repositories";
import { RuntimeReportingEngine } from "./reporting";
import { BackgroundRuntime, MonitoringWorker } from "./runtime";
import { ClaudeSessionManager } from "./session";
import { DeferredRuntimeStatusService, RuntimeStatusService } from "./status";
import { StrategyEngine } from "./strategy";
import {
  TelegramAdapter,
  TelegramApiClient,
  TelegramApprovalProvider,
  TelegramAttentionTransport,
  TelegramLongPoller,
  TelegramSecurity,
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
  // built. Its record() method is never called anywhere in this file —
  // deciding when a planning cycle should be recorded is left to a future
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
  // Phase 9.4: the consumer-facing façade over the recorded-planning domain
  // (autonomousPlanHistoryService + autonomousPlanStateEngine, both already
  // built above) — ApplicationService now depends on this one instance
  // instead of the two collaborators it composes, individually, itself.
  // Neither collaborator changed; this is purely a re-wiring. No ordering
  // constraint, no seam needed: both of its dependencies already exist.
  const autonomousPlanningService = new AutonomousPlanningService(autonomousPlanHistoryService, autonomousPlanStateEngine);
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
  );

  // Background Runtime cluster (Phase 8.2, extended in Phase 8.3, gated by
  // policy in Phase 8.4): RuntimePolicyEngine, ProactiveMonitor,
  // AttentionDispatcher, MonitoringWorker, and BackgroundRuntime are
  // constructed and started together, immediately after the read-only
  // intelligence cluster they depend on, rather than scattered across
  // bootstrap — they are one unit of composition. None of them depend on
  // Telegram or on the decision-pipeline/execution stack built below, and
  // BackgroundRuntime's lifecycle (start here, stop in the shared shutdown
  // handler at the bottom of this function) is intentionally independent of
  // whether Telegram ends up enabled: monitoring must keep running whether or
  // not any transport is active. MonitoringWorker stays read-only — its
  // dependencies are IProactiveMonitor, IRepositoryRegistry,
  // IAttentionDispatcher, and IRuntimePolicyEngine, none of which can execute
  // a Task/workflow or reach ControllerCore/ExecutionPipeline.
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
  const runtimePolicyEngine = new RuntimePolicyEngine();
  const proactiveMonitor = new ProactiveMonitor(applicationService);
  const attentionDispatcher = new AttentionDispatcher(runtimePolicyEngine);
  const monitoringWorker = new MonitoringWorker(
    proactiveMonitor,
    repositoryRegistry,
    attentionDispatcher,
    runtimePolicyEngine,
  );
  const backgroundRuntime = new BackgroundRuntime([monitoringWorker]);
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

  // Strategy Engine / Planning Engine / Execution Coordinator (Phases 7.1-7.3)
  // are the autonomous decision-support stack: Task -> TaskExecutionStrategy
  // -> ExecutionPlan -> CapabilityProgram. None of them execute anything —
  // ExecutionPipeline below is what finally turns a CapabilityProgram into
  // real ControllerCore calls.
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

  const shutdown = (): void => {
    poller?.stop();
    backgroundRuntime.stop();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const telegramConfig = configService.getTelegramConfig();
  if (!telegramConfig.telegram.enabled) {
    controllerEntryPoint.bind(new MemoryRecordingControllerCore(plainControllerCore, projectMemory));
    console.log("Telegram transport disabled (telegram.enabled = false in config/telegram.yaml).");
    return;
  }

  const telegramClient = new TelegramApiClient(configService);
  const telegramSecurity = new TelegramSecurity(configService);
  // Registers this exact same attentionDispatcher (built above, before this
  // branch was known to be reached) with its one Telegram-specific transport
  // — the only place in this file where the attention-delivery cluster and
  // Telegram meet. AttentionDispatcher itself is unaware this happened.
  attentionDispatcher.addTransport(new TelegramAttentionTransport(telegramClient, configService));
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

  // ExecutionPipeline is now the single runtime entrypoint Telegram submits
  // engineering task execution requests to (Phase 7.5) — it was built above
  // against controllerEntryPoint, so it transparently reaches this same
  // fully-decorated controllerCore (approval-gated, memory-recording) now
  // that binding has happened, identical to how WorkflowOrchestrator does.
  const telegramAdapter = new TelegramAdapter(executionPipeline, applicationService, telegramSecurity, telegramClient);
  poller = new TelegramLongPoller(telegramClient, telegramAdapter, telegramApprovalProvider);

  console.log("Telegram transport enabled, starting long polling.");
  await poller.start();
}

bootstrap().catch((error) => {
  console.error("Failed to start AI Controller:", error instanceof Error ? error.message : error);
  process.exit(1);
});
