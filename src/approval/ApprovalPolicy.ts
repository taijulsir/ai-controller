import type { ControllerConfig } from "../config/types";
import type { Task } from "../planner/types";
import type { IApprovalPolicy } from "./interfaces";

export class ApprovalPolicy implements IApprovalPolicy {
  requiresApproval(task: Task, controllerConfig: ControllerConfig): boolean {
    const { approval } = controllerConfig;
    if (approval.mode !== "manual") {
      return false;
    }

    // Generic path: any task type can be listed in require_before without
    // this class ever changing again -- adding a newly approval-worthy
    // command (e.g. "merge") is a config change, not a code change. Takes
    // full priority over the legacy fields below whenever present, even if
    // both happen to be present in the same config.
    if (approval.require_before !== undefined) {
      return approval.require_before.includes(task.type);
    }

    // Legacy fallback -- this class's exact original behavior, preserved
    // verbatim for any config that predates require_before and has not
    // adopted it. Only ever reached when require_before is absent.
    if (task.type === "push-changes") {
      return approval.require_before_git_push ?? false;
    }
    if (task.type === "create-pull-request") {
      return approval.require_before_pull_request ?? false;
    }
    return false;
  }
}
