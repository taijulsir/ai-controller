import type { RepositorySnapshot } from "../intelligence/types";
import type { Task } from "../planner/types";
import type { TaskExecutionStrategy } from "../strategy/types";

// "What needs to happen" — not "which task/workflow runs it". Deliberately
// one level above executable Tasks: a future Execution Coordinator decides
// how each goal is fulfilled (which Task, which registered workflow, or a
// not-yet-existing capability like branch creation), so different execution
// policies can change without this plan changing.
export type EngineeringGoal =
  | "VerifyRepositoryReadiness"
  | "DeliverIntegratedChange"
  | "AwaitHumanReview"
  | "AwaitApproval"
  | "CreateFeatureBranch"
  | "ContinueImplementation";

// The inputs an integrated delivery operation needs (commit message / PR
// title, body, base branch), captured once — here, at the point that still
// has the original typed Task in hand — and carried forward unchanged by
// every later stage. Nothing downstream re-derives this from plan.task.
export interface DeliveryInput {
  message: string;
  body?: string;
  baseBranch?: string;
}

export interface PlanStep {
  order: number;
  goal: EngineeringGoal;
  rationale: string;
  deliveryInput?: DeliveryInput;
}

export interface PlanningInput {
  task: Task;
  strategy: TaskExecutionStrategy;
  repository: RepositorySnapshot;
}

export interface ExecutionPlan {
  repositoryId: string;
  task: Task;
  strategy: TaskExecutionStrategy;
  steps: PlanStep[];
  generatedAt: Date;
}
