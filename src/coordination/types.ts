import type { DeliveryInput, EngineeringGoal, ExecutionPlan } from "../planning/types";

// A required engineering capability — one level below an EngineeringGoal
// (which describes *what needs to happen*) and deliberately above any Task or
// workflow (which describe *how*). Translating a Capability into a concrete
// Task/workflow is explicitly out of scope for this module; it belongs to a
// future execution/dispatch layer.
export type Capability =
  | "VerifyRepository"
  | "PublishRepository"
  | "RequestIntegration"
  | "ContinueImplementation"
  | "HumanReview"
  | "BranchManagement"
  | "IntegratedDelivery";

export interface CapabilityStep {
  order: number;
  goal: EngineeringGoal;
  capability: Capability;
  rationale: string;
  // Carried forward unchanged from the originating PlanStep — this module
  // never inspects plan.task to derive or recompute it.
  deliveryInput?: DeliveryInput;
}

export interface CapabilityProgram {
  repositoryId: string;
  plan: ExecutionPlan;
  steps: CapabilityStep[];
  generatedAt: Date;
}
