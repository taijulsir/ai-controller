import type { PipelineResult } from "../pipeline/types";

// Phase 11: the first, and only, place in this codebase where a
// planning-facing dependency and an execution-facing dependency are held by
// the same class. One method: it reads its own input (the schedule) rather
// than receiving it from a caller, since — unlike
// AutonomousPlanRecordingService.recordAutonomousPlanCycle(plan), which
// receives an already-synthesized plan because only ApplicationService may
// ever synthesize one — reading a bounded, already-computed schedule report
// carries none of that risk, and requiring every caller to fetch and pass it
// in first would gain nothing.
export interface IAutonomousExecutionOrchestrator {
  // Phase 12: correlationId is optional and, when supplied, is forwarded
  // unchanged into the PipelineRequest this class builds — never inspected,
  // parsed, or validated here. This class stays transport-agnostic: it has
  // no idea a Telegram-shaped correlationId even exists, the same way
  // PipelineRequest/ExecutionRequest/ApprovalRequest already treat
  // correlationId as an opaque string. Omitting it preserves Phase 11's
  // exact original behavior (ExecutionPipeline generates one internally) —
  // this is what "a future non-Telegram trigger with no chat to correlate
  // back to" (PipelineRequest's own doc comment) already anticipated.
  //
  // Returns the real PipelineResult when the highest-priority scheduled item
  // was translatable and an execution attempt was actually submitted through
  // IExecutionPipeline; returns undefined when nothing was attempted (an
  // empty schedule, or a top item whose RecommendationKind has no
  // translation) — never a fabricated result standing in for "nothing
  // happened".
  attemptExecution(correlationId?: string): Promise<PipelineResult | undefined>;
}
