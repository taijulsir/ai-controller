export interface WorkerStatus {
  id: string;
  running: boolean;
}

export interface BackgroundRuntimeStatus {
  running: boolean;
  startedAt?: Date;
  // Computed from Date.now() at the moment getStatus() is called, not
  // tracked as its own field — undefined whenever the runtime isn't running
  // or has no startedAt yet.
  uptimeMs?: number;
  workers: WorkerStatus[];
}

export interface MonitoringWorkerStatus {
  running: boolean;
  lastCycleAt?: Date;
  repositoriesMonitoredLastCycle: number;
  repositoriesSkippedLastCycle: number;
}
