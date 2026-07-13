import { ControllerCore } from "./controller";
import { ConfigService } from "./config";
import { TaskPlanner, WorkflowFactory } from "./planner";
import { RepositoryRegistry } from "./repositories";

function bootstrap(): void {
  const configService = new ConfigService();
  const repositoryRegistry = new RepositoryRegistry(configService);
  const workflowFactory = new WorkflowFactory(configService, repositoryRegistry);
  const taskPlanner = new TaskPlanner(configService, workflowFactory);

  // Constructed and ready for the next entry point (Telegram/CLI/REST) to call
  // execute() on. No transport is wired up yet, so nothing calls it today.
  const controllerCore = new ControllerCore(repositoryRegistry, taskPlanner);
  void controllerCore;

  const controllerConfig = configService.getControllerConfig();
  const repositories = repositoryRegistry.getAllRepositories();

  console.log(`${controllerConfig.controller.name} v${controllerConfig.controller.version} started.`);
  console.log(
    `Registered repositories: ${repositories.length === 0 ? "none" : repositories.map((repo) => repo.id).join(", ")}`,
  );
}

try {
  bootstrap();
} catch (error) {
  console.error("Failed to start AI Controller:", error instanceof Error ? error.message : error);
  process.exit(1);
}
