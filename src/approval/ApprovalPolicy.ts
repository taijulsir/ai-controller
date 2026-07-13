import type { ControllerConfig } from "../config/types";
import type { Task } from "../planner/types";
import type { IApprovalPolicy } from "./interfaces";

export class ApprovalPolicy implements IApprovalPolicy {
  requiresApproval(task: Task, controllerConfig: ControllerConfig): boolean {
    if (controllerConfig.approval.mode !== "manual") {
      return false;
    }

    if (task.type === "push-changes") {
      return controllerConfig.approval.require_before_git_push;
    }

    if (task.type === "create-pull-request") {
      return controllerConfig.approval.require_before_pull_request;
    }

    return false;
  }
}
