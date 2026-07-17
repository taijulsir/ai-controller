import type { IAutonomousPlanScheduleProvider } from "../application/interfaces";
import type { IExecutionPipeline } from "../pipeline/interfaces";
import type { PipelineRequest, PipelineResult } from "../pipeline/types";
import type { AutonomousPlanSchedulingEntry } from "../scheduling/types";
import type { IAutonomousExecutionOrchestrator } from "./interfaces";

// Phase 11: the first execution-capable component this codebase has. Reuses
// the descriptive pipeline's own already-established order verbatim
// (schedule.entries[0] — Plan Sequencing's own doc comment guarantees this
// array is already ranked, and Scheduling never re-sorts it) rather than
// deriving a priority of its own, and reuses ExecutionPipeline's own
// existing "pipeline" PipelineRequest — the exact request shape
// TelegramAdapter already builds for "/ship" (see its own
// buildPipelineRequest() doc comment) — rather than inventing a second way
// to reach the shipWorkflow. Neither ExecutionPipeline, ControllerCore,
// ApprovalEngine, ApprovalPolicy, nor shipWorkflow itself needed any change
// for this to work: this class only ever submits the same kind of request
// Telegram already does, so it inherits the exact same ApprovalPolicy
// gating (push-changes, create-pull-request) automatically, for free.
//
// Depends on IAutonomousPlanScheduleProvider, not the full
// IApplicationService, and IExecutionPipeline — nothing else. Translates
// only RecommendationKind "RepositoryReadyToShip"; every other kind is
// deliberately left untranslated, never guessed at. Readiness/Sequencing/
// Scheduling data is used only to select *which* item to attempt, never as
// a substitute for ApprovalPolicy's own, unchanged, downstream approval
// decision.
export class AutonomousExecutionOrchestrator implements IAutonomousExecutionOrchestrator {
  constructor(
    private readonly scheduleProvider: IAutonomousPlanScheduleProvider,
    private readonly executionPipeline: IExecutionPipeline,
  ) {}

  async attemptExecution(correlationId?: string): Promise<PipelineResult | undefined> {
    // limit: 1 -- only the single highest-priority entry is ever consulted,
    // and the descriptive pipeline's own ordering means requesting more
    // could never change which entry that is.
    const schedule = await this.scheduleProvider.getAutonomousPlanSchedule(1);
    const [topEntry] = schedule.entries;
    if (!topEntry) {
      return undefined;
    }

    const request = this.translate(topEntry, correlationId);
    if (!request) {
      return undefined;
    }

    return this.executionPipeline.run(request);
  }

  // The one place a RecommendationKind is checked. Every kind other than
  // "RepositoryReadyToShip" returns undefined -- no fallback, no best-effort
  // guess, no partial translation.
  private translate(entry: AutonomousPlanSchedulingEntry, correlationId?: string): PipelineRequest | undefined {
    if (entry.sourceRecommendationKind !== "RepositoryReadyToShip") {
      return undefined;
    }

    return {
      kind: "pipeline",
      // AutonomousPlanSchedulingEntry carries no free-text field (Readiness
      // already dropped AutonomousPlanItem.reason) -- this message is
      // synthesized from the fields that do survive the descriptive
      // pipeline, clearly identifiable as autonomously triggered rather
      // than authored by a person.
      message: `autonomous-execution: ship ${entry.repositoryId} (readiness ${entry.level})`,
      repositoryId: entry.repositoryId,
      // Phase 12: forwarded unchanged from attemptExecution()'s own
      // parameter when a caller supplies one (e.g. Telegram's own
      // chat/update-derived id, needed for TelegramApprovalProvider to route
      // an approval prompt back to the right chat). When omitted,
      // ExecutionPipeline generates one internally -- Phase 11's exact
      // original behavior, unchanged.
      correlationId,
    };
  }
}
