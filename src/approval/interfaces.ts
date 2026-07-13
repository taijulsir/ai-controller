import type { ControllerConfig } from "../config/types";
import type { Task } from "../planner/types";
import type { ApprovalDecision, ApprovalRequest } from "./types";

export interface IApprovalProvider {
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface IApprovalPolicy {
  requiresApproval(task: Task, controllerConfig: ControllerConfig): boolean;
}
