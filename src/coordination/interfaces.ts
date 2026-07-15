import type { ExecutionPlan } from "../planning/types";
import type { CapabilityProgram } from "./types";

export interface IExecutionCoordinator {
  buildProgram(plan: ExecutionPlan): CapabilityProgram;
}
