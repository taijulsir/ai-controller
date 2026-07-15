import type { CapabilityProgram, Capability } from "../coordination/types";
import type { ExecutionRequest, ExecutionResult } from "../controller/types";
import type { RepositorySnapshot } from "../intelligence/types";
import type { Task } from "../planner/types";
import type { ExecutionPlan } from "../planning/types";
import type { TaskExecutionStrategy } from "../strategy/types";

// The single immutable snapshot of repository state shared by every stage of
// one pipeline run. Deliberately narrow: only the stable repository facts a
// decision stage needs, not memory history, session state, or insights —
// those stay owned by ProjectMemoryService/ClaudeSessionManager/DecisionEngine
// respectively, fetched independently wherever they're still needed.
export interface PipelineContext {
  task: Task;
  repositoryId: string;
  repository: RepositorySnapshot;
  generatedAt: Date;
}

// The discriminant describes *how the request is processed*, not which
// workflow it eventually becomes:
//   - "task" requests carry a literal Task — bypass eligibility is decided by
//     its task.type alone.
//   - "pipeline" requests are unconditionally processed through the full
//     Strategy/Planning/Coordination stack, never bypass-eligible, regardless
//     of what ExecutionPipeline ends up dispatching as a result. A caller
//     (Telegram's "/ship" today) uses this kind because it wants the full
//     autonomous judgment applied — even though the Task ExecutionPipeline
//     currently synthesizes internally to represent that judgment's input
//     (create-commit, carrying the same message) is *also* one of the task
//     types that bypasses when submitted as a literal standalone "task"
//     request. Task shape alone can't distinguish "/commit" from "/ship" —
//     this discriminant is what does, without handing the bypass decision
//     itself back to the caller, and without coupling the request shape to
//     today's one caller of it or today's one workflow it resolves to.
export type PipelineRequest =
  | { kind: "task"; task: Task; repositoryId?: string; correlationId?: string }
  | { kind: "pipeline"; message: string; repositoryId?: string; correlationId?: string };

// Callers with an existing correlation id (Telegram's chat/update-derived id,
// needed for TelegramApprovalProvider to route an approval prompt back to the
// right chat) must supply it via PipelineRequest.correlationId — the pipeline
// never invents one that would break that lookup. Only generated internally
// when absent (e.g. a future non-Telegram trigger with no chat to correlate
// back to).

export type PipelineStepOutcome =
  | { status: "executed"; capability: Capability; request: ExecutionRequest; result: ExecutionResult }
  // No automated capability exists for this step at all (BranchManagement,
  // HumanReview) — a structural gap, not a data gap. Distinct from "skipped"
  // so a caller can't casually treat it the same as a missing parameter.
  | { status: "blocked"; capability: Capability; explanation: string; recommendedAction: string }
  // The capability exists but this specific step is missing data it needs
  // (e.g. IntegratedDelivery with no deliveryInput) — never fabricated.
  | { status: "skipped"; capability: Capability; reason: string };

export type PipelineResult =
  | {
      path: "full";
      context: PipelineContext;
      strategy: TaskExecutionStrategy;
      plan: ExecutionPlan;
      program: CapabilityProgram;
      stepOutcomes: PipelineStepOutcome[];
      completed: boolean;
    }
  // create-commit / push-changes / create-pull-request submitted as
  // standalone commands bypass Strategy/Planning/Coordination entirely —
  // StrategyEngine's task-type cascade was built to judge an integrated
  // delivery *intent*, not to preserve a narrow standalone command's exact
  // scope, so running it here would silently reinterpret "just push" as
  // "ship everything". ExecutionPipeline is still the only thing that
  // decided this and the only thing that called ControllerCore — it just
  // decided not to manufacture a Strategy/Plan/Program for a question that
  // was never in doubt.
  | {
      path: "bypass";
      context: PipelineContext;
      request: ExecutionRequest;
      result: ExecutionResult;
      completed: boolean;
    };
