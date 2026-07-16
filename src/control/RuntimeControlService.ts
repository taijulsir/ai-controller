import type { IAttentionDispatcher } from "../attention/interfaces";
import type { IRuntimePolicyEngine } from "../policy/interfaces";
import type { IBackgroundRuntime } from "../runtime/interfaces";
import type { IRuntimeControlService } from "./interfaces";

// Pure orchestration over existing runtime components: owns zero mutable
// state of its own — no fields beyond its three readonly constructor
// references — and performs no engineering execution. It has no dependency
// on ExecutionPipeline, ControllerCore, Claude, any repository adapter, or
// Telegram, so it cannot reach any of them, by construction. Every method
// below is exactly one direct call to one of its three collaborators' own
// pre-existing methods; nothing is decided, computed, retried, or tracked
// here.
//
// Maintenance mode and repository enable/disable remain exclusively owned by
// RuntimePolicyEngine: enableRepository()/disableRepository() are a
// friendlier two-method naming over its single intent-based
// setRepositoryMonitoringEnabled(id, enabled) API, not a second copy of that
// decision — the actual state (which repositories are disabled, whether
// maintenance mode is on) lives only inside RuntimePolicyEngine, exactly as
// it did before this class existed.
export class RuntimeControlService implements IRuntimeControlService {
  constructor(
    private readonly runtimePolicy: IRuntimePolicyEngine,
    private readonly backgroundRuntime: IBackgroundRuntime,
    private readonly attentionDispatcher: IAttentionDispatcher,
  ) {}

  // Realized as BackgroundRuntime.stop()/start(): today the only worker it
  // hosts is MonitoringWorker, so this is monitoring-equivalent in practice,
  // but it is a runtime-wide pause/resume, not a monitoring-specific
  // mechanism invented here — BackgroundRuntime's own keep-alive handle
  // (Phase 8.2) stops too while paused, exactly as it would if something
  // else called stop() directly. resumeMonitoring() while already running
  // throws BackgroundRuntime's own pre-existing RuntimeAlreadyStartedError,
  // unmodified and unguarded — this class does not track or paper over that
  // itself, since doing so would mean holding state of its own.
  pauseMonitoring(): void {
    this.backgroundRuntime.stop();
  }

  resumeMonitoring(): void {
    this.backgroundRuntime.start();
  }

  enterMaintenanceMode(): void {
    this.runtimePolicy.setMaintenanceMode(true);
  }

  exitMaintenanceMode(): void {
    this.runtimePolicy.setMaintenanceMode(false);
  }

  enableRepository(repositoryId: string): void {
    this.runtimePolicy.setRepositoryMonitoringEnabled(repositoryId, true);
  }

  disableRepository(repositoryId: string): void {
    this.runtimePolicy.setRepositoryMonitoringEnabled(repositoryId, false);
  }

  resetDispatcherStatistics(): void {
    this.attentionDispatcher.resetStatistics();
  }

  resetRuntimeStatistics(): void {
    this.backgroundRuntime.resetStatistics();
  }
}
