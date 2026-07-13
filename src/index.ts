import { existsSync } from "node:fs";
import path from "node:path";
import { ControllerCore } from "./controller";
import { ConfigService } from "./config";
import { TaskPlanner, WorkflowFactory } from "./planner";
import { RepositoryRegistry } from "./repositories";
import { TelegramAdapter, TelegramApiClient, TelegramLongPoller, TelegramSecurity } from "./telegram";

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
  const controllerCore = new ControllerCore(repositoryRegistry, taskPlanner);

  const controllerConfig = configService.getControllerConfig();
  const repositories = repositoryRegistry.getAllRepositories();

  console.log(`${controllerConfig.controller.name} v${controllerConfig.controller.version} started.`);
  console.log(
    `Registered repositories: ${repositories.length === 0 ? "none" : repositories.map((repo) => repo.id).join(", ")}`,
  );

  const telegramConfig = configService.getTelegramConfig();
  if (!telegramConfig.telegram.enabled) {
    console.log("Telegram transport disabled (telegram.enabled = false in config/telegram.yaml).");
    return;
  }

  const telegramClient = new TelegramApiClient(configService);
  const telegramSecurity = new TelegramSecurity(configService);
  const telegramAdapter = new TelegramAdapter(controllerCore, telegramSecurity, telegramClient);
  const poller = new TelegramLongPoller(telegramClient, telegramAdapter);

  process.once("SIGINT", () => poller.stop());
  process.once("SIGTERM", () => poller.stop());

  console.log("Telegram transport enabled, starting long polling.");
  await poller.start();
}

bootstrap().catch((error) => {
  console.error("Failed to start AI Controller:", error instanceof Error ? error.message : error);
  process.exit(1);
});
