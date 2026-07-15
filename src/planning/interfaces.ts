import type { ExecutionPlan, PlanningInput } from "./types";

export interface IPlanningEngine {
  buildPlan(input: PlanningInput): ExecutionPlan;
}
