import type { AttentionDispatcherStatus } from "../attention/types";
import type { RuntimePolicyStatus } from "../policy/types";
import type { MonitoringWorkerStatus, WorkerStatus } from "../runtime/types";

// The runtime's own started/stopped/uptime facts, extracted from
// BackgroundRuntimeStatus — kept as its own top-level section (rather than
// folded into "workers") since it describes the runtime container itself,
// not any individual worker.
export interface RuntimeSectionStatus {
  running: boolean;
  startedAt?: Date;
  uptimeMs?: number;
}

// An immutable, point-in-time snapshot — never a live object a caller could
// hold and expect to update itself. Getting a fresher view means calling
// IRuntimeStatusService.getStatus() again, matching every other "report"
// type already in this codebase (RepositorySnapshot, RepositoryInsightReport,
// RepositoryRecommendationReport, EngineeringWorkspace, ...). Every field
// here is copied directly from one of runtime/attention/policy's own
// getStatus() methods — nothing is recomputed or re-derived by whoever
// assembles this.
export interface RuntimeStatus {
  runtime: RuntimeSectionStatus;
  workers: WorkerStatus[];
  monitoring: MonitoringWorkerStatus;
  policy: RuntimePolicyStatus;
  attention: AttentionDispatcherStatus;
  generatedAt: Date;
}
