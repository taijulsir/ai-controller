import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IConfigService } from "../config/interfaces";
import type { IBackgroundWorker } from "./interfaces";

// Kept as an internal constant for now, same "kept internal for now"
// precedent as every other worker's own interval — much shorter than
// MonitoringWorker's 15 minutes deliberately: a liveness signal is only
// useful if it's fresher than how quickly an operator (or an external health
// checker) needs to notice the process has stopped responding.
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute
const HEALTH_FILE_NAME = "health.json";

// Health checks (Stage 4, operational hardening): this process has no HTTP
// server and isn't gaining one here — opening a network port purely to
// answer liveness checks would be a real new capability (new inbound
// surface, new dependency, new auth questions), not an operational-hardening
// fix. Instead this worker does the smallest thing that makes an external
// liveness check possible for a non-HTTP background process: write a small
// JSON heartbeat file on a fixed cadence, reusing the same
// "write-JSON-to-memory.directory" pattern ProjectMemoryService and
// AutonomousPlanHistoryService already established. scripts/health-check.ts
// is the companion reader — usable manually, from cron, or from a process
// supervisor's own external check hook.
//
// Deliberately dependency-free beyond IConfigService (only to locate
// memory.directory, the same directory the other two JSONL writers already
// use) — no IApplicationService, no RuntimeStatus, no reference capable of
// reaching ControllerCore/ExecutionPipeline/any adapter. Its only job is:
// "is the process's own event loop still alive and ticking." A richer
// health payload (worker statuses, etc.) was deliberately left out — the
// existing `/runtime status` Telegram command and getRuntimeReport() already
// answer that richer question when Telegram is enabled; this worker only
// answers the narrower "is anything at all still running" question that
// remains meaningful even when Telegram is disabled.
export class HealthCheckWorker implements IBackgroundWorker {
  readonly id = "health-check-worker";

  private intervalHandle?: NodeJS.Timeout;
  private ticking = false;
  private lastWriteAt?: Date;
  private lastError?: string;

  constructor(
    private readonly configService: IConfigService,
    private readonly intervalMs: number = DEFAULT_HEALTH_CHECK_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.intervalHandle) {
      return;
    }
    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // unref()'d deliberately, same as every other worker's own timer: this
    // worker must never be the reason the process stays alive on its own.
    this.intervalHandle.unref?.();
  }

  stop(): void {
    if (!this.intervalHandle) {
      return;
    }
    clearInterval(this.intervalHandle);
    this.intervalHandle = undefined;
  }

  // Re-entrancy guard, same shape as every other worker's own guard.
  private async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      const { memory } = this.configService.getControllerConfig();
      await mkdir(memory.directory, { recursive: true });
      const heartbeat = {
        status: "ok",
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        writtenAt: new Date().toISOString(),
      };
      await writeFile(path.join(memory.directory, HEALTH_FILE_NAME), JSON.stringify(heartbeat, null, 2), "utf8");
      this.lastWriteAt = new Date();
      this.lastError = undefined;
    } catch (error) {
      // Caught and logged, never rethrown — same failure handling as every
      // other worker's tick(): a failed write must never stop this worker's
      // timer or propagate out of the interval callback.
      const message = error instanceof Error ? error.message : String(error);
      console.error("health-check-worker: tick failed:", message);
      this.lastError = message;
    } finally {
      this.ticking = false;
    }
  }

  // Concrete, additive method, same precedent as MonitoringWorker.getStatus()
  // / AutonomousPlanRecordingWorker.getStatus() — not part of IBackgroundWorker.
  getStatus(): { running: boolean; lastWriteAt?: Date; lastError?: string } {
    return {
      running: this.intervalHandle !== undefined,
      lastWriteAt: this.lastWriteAt,
      lastError: this.lastError,
    };
  }
}
