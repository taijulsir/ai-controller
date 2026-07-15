import type { EngineeringGoal, ExecutionPlan } from "../planning/types";
import type { Task } from "../planner/types";
import type { IExecutionCoordinator } from "./interfaces";
import type { Capability, CapabilityProgram } from "./types";

// Pure transform, same as PlanningEngine: no constructor dependencies, no
// I/O, synchronous. It relabels each EngineeringGoal as the Capability
// required to fulfill it — it never picks a concrete Task or workflow to
// provide that capability, so there is nothing here that could execute a
// workflow, call ControllerCore/Claude, or modify a repository.
export class ExecutionCoordinator implements IExecutionCoordinator {
  buildProgram(plan: ExecutionPlan): CapabilityProgram {
    return {
      repositoryId: plan.repositoryId,
      plan,
      steps: plan.steps.map((step) => ({
        order: step.order,
        goal: step.goal,
        capability: this.capabilityFor(step.goal, plan.task),
        rationale: step.rationale,
        deliveryInput: step.deliveryInput,
      })),
      generatedAt: new Date(),
    };
  }

  private capabilityFor(goal: EngineeringGoal, task: Task): Capability {
    switch (goal) {
      case "VerifyRepositoryReadiness":
        return "VerifyRepository";
      case "DeliverIntegratedChange":
        return "IntegratedDelivery";
      case "ContinueImplementation":
        return "ContinueImplementation";
      case "AwaitHumanReview":
        return "HumanReview";
      case "CreateFeatureBranch":
        return "BranchManagement";
      // No "approval" capability exists, and none should: approval is not a
      // capability the Coordinator requests, it's a side effect ApprovalEngine
      // applies automatically when the real execution pipeline later provides
      // whichever capability the originating task actually needed (Publish
      // Repository for push-changes, RequestIntegration for
      // create-pull-request). The Coordinator only re-derives that same
      // capability here — it has no opinion on approval at all.
      case "AwaitApproval":
        return task.type === "create-pull-request" ? "RequestIntegration" : "PublishRepository";
    }
  }
}
