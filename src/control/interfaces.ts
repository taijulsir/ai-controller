// Runtime administration only — no engineering execution, no Claude, no
// repository access, no Telegram, no ExecutionPipeline. Every method here
// manages runtime infrastructure (is monitoring paused, is maintenance mode
// on, is this repository being watched, what do the delivery/runtime
// statistics currently read) and nothing else.
export interface IRuntimeControlService {
  pauseMonitoring(): void;
  resumeMonitoring(): void;
  enterMaintenanceMode(): void;
  exitMaintenanceMode(): void;
  enableRepository(repositoryId: string): void;
  disableRepository(repositoryId: string): void;
  resetDispatcherStatistics(): void;
  resetRuntimeStatistics(): void;
}
