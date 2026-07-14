import { existsSync } from "node:fs";
import path from "node:path";
import { ApprovalEngine } from "./approval";
import { ControllerCore, DeferredControllerCore } from "./controller";
import { ConfigService } from "./config";
import { TaskPlanner, WorkflowFactory } from "./planner";
import { WorkflowOrchestrator, WorkflowRegistry } from "./orchestration";
import { RepositoryRegistry } from "./repositories";
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
  const workflowFactory = new WorkflowFactory(configService, repositoryRegistry);
  const taskPlanner = new TaskPlanner(configService, workflowFactory);

  // WorkflowOrchestrator needs "the top-of-stack IControllerCore" (plain, or
  // ApprovalEngine-wrapped) so every step it runs still passes through
  // approval — but that instance doesn't exist yet until after
  // ControllerCore (which needs the orchestrator) is built. DeferredControllerCore
  // is the seam: bound below, once the real entry point is known.
  const controllerEntryPoint = new DeferredControllerCore();
  const workflowRegistry = new WorkflowRegistry();
  const workflowOrchestrator = new WorkflowOrchestrator(controllerEntryPoint, workflowRegistry);

  const plainControllerCore = new ControllerCore(repositoryRegistry, taskPlanner, workflowOrchestrator);

  const controllerConfig = configService.getControllerConfig();
  const repositories = repositoryRegistry.getAllRepositories();

  console.log(`${controllerConfig.controller.name} v${controllerConfig.controller.version} started.`);
  console.log(
    `Registered repositories: ${repositories.length === 0 ? "none" : repositories.map((repo) => repo.id).join(", ")}`,
  );

  const telegramConfig = configService.getTelegramConfig();
  if (!telegramConfig.telegram.enabled) {
    controllerEntryPoint.bind(plainControllerCore);
    console.log("Telegram transport disabled (telegram.enabled = false in config/telegram.yaml).");
    return;
  }

  const telegramClient = new TelegramApiClient(configService);
  const telegramSecurity = new TelegramSecurity(configService);
  const telegramApprovalProvider = new TelegramApprovalProvider(telegramClient, telegramSecurity);
  const controllerCore = new ApprovalEngine(plainControllerCore, configService, telegramApprovalProvider);
  controllerEntryPoint.bind(controllerCore);

  const telegramAdapter = new TelegramAdapter(controllerCore, telegramSecurity, telegramClient);
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
