import { existsSync } from "node:fs";
import path from "node:path";
import { ApplicationService } from "./application";
import { ApprovalEngine } from "./approval";
import { EngineeringAssistanceEngine } from "./assistance";
import { ContextBuilder } from "./context";
import { ExecutionCoordinator } from "./coordination";
import { ControllerCore, DeferredControllerCore } from "./controller";
import { ConfigService } from "./config";
import { DecisionEngine } from "./decisions";
import { RepositoryIntelligenceService } from "./intelligence";
import { MemoryRecordingControllerCore, ProjectMemoryService } from "./memory";
import { TaskPlanner, WorkflowFactory } from "./planner";
import { ExecutionPipeline } from "./pipeline";
import { PlanningEngine } from "./planning";
import { WorkflowOrchestrator, WorkflowRegistry } from "./orchestration";
import { RecommendationEngine } from "./recommendations";
import { RepositoryRegistry } from "./repositories";
import { ClaudeSessionManager } from "./session";
import { StrategyEngine } from "./strategy";
import {
  TelegramAdapter,
  TelegramApiClient,
  TelegramApprovalProvider,
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
  const applicationService = new ApplicationService(
    repositoryIntelligence,
    projectMemory,
    decisionEngine,
    sessionManager,
    repositoryRegistry,
    recommendationEngine,
    engineeringAssistanceEngine,
  );

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

  const telegramConfig = configService.getTelegramConfig();
  if (!telegramConfig.telegram.enabled) {
    controllerEntryPoint.bind(new MemoryRecordingControllerCore(plainControllerCore, projectMemory));
    console.log("Telegram transport disabled (telegram.enabled = false in config/telegram.yaml).");
    return;
  }

  const telegramClient = new TelegramApiClient(configService);
  const telegramSecurity = new TelegramSecurity(configService);
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
  const poller = new TelegramLongPoller(telegramClient, telegramAdapter, telegramApprovalProvider);

  process.once("SIGINT", () => poller.stop());
  process.once("SIGTERM", () => poller.stop());

  console.log("Telegram transport enabled, starting long polling.");
  await poller.start();
}

bootstrap().catch((error) => {
  console.error("Failed to start AI Controller:", error instanceof Error ? error.message : error);
  process.exit(1);
});
