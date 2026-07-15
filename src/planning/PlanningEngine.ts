import type { RepositorySnapshot } from "../intelligence/types";
import type { Task } from "../planner/types";
import type { TaskExecutionStrategy } from "../strategy/types";
import type { IPlanningEngine } from "./interfaces";
import type { DeliveryInput, EngineeringGoal, ExecutionPlan, PlanStep, PlanningInput } from "./types";

// Pure transform: no constructor dependencies, no I/O, synchronous. It only
// ever sees data already computed by RepositoryIntelligenceService and
// StrategyEngine — it never calls either service (or ControllerCore, Claude,
// or a workflow) itself, so there is nothing here that could execute or
// modify a repository even by accident.
export class PlanningEngine implements IPlanningEngine {
  buildPlan(input: PlanningInput): ExecutionPlan {
    const { task, strategy, repository } = input;

    return {
      repositoryId: strategy.repositoryId,
      task,
      strategy,
      steps: this.buildSteps(task, strategy, repository),
      generatedAt: new Date(),
    };
  }

  private buildSteps(task: Task, strategy: TaskExecutionStrategy, repository: RepositorySnapshot): PlanStep[] {
    switch (strategy.recommendedAction) {
      case "ReviewRepository":
        return [this.step(1, "AwaitHumanReview", this.describeReviewRationale(strategy))];

      case "WaitForApproval":
        return [
          this.step(
            1,
            "AwaitApproval",
            strategy.approvalExpectation.reason ?? "Approval is required before this action can proceed.",
          ),
        ];

      case "AnalyzeFirst":
        return [
          this.step(
            1,
            "VerifyRepositoryReadiness",
            `Inspect repository "${repository.repository.name}" (branch "${repository.branch.current}") before proceeding.`,
          ),
        ];

      case "ContinueCurrentTask":
        return [
          this.step(
            1,
            "ContinueImplementation",
            "An active Claude session exists for this repository; continue the in-progress work.",
          ),
        ];

      case "CreateFeatureBranch":
        return [
          this.step(
            1,
            "CreateFeatureBranch",
            `Currently on the default branch ("${repository.branch.default}"); create a feature branch before implementing.`,
          ),
          this.step(2, "ContinueImplementation", "Implement the requested change on the new branch."),
        ];

      case "ShipChanges":
        return [
          this.step(
            1,
            "DeliverIntegratedChange",
            repository.pullRequests.openCount > 0
              ? `Verify, commit, publish, and open a pull request for review (note: ${repository.pullRequests.openCount} pull request(s) already open on this repository).`
              : "Verify, commit, publish, and open a pull request for review.",
            this.deliveryInputFor(task),
          ),
        ];
    }
  }

  private describeReviewRationale(strategy: TaskExecutionStrategy): string {
    if (strategy.executionReadiness.blockers.length > 0) {
      return `Repository is not ready: ${strategy.executionReadiness.blockers.join("; ")}`;
    }
    return "Repository state requires review before proceeding.";
  }

  // Captured once, here, while the original typed Task is still in hand.
  // Undefined when the originating task carries nothing usable (e.g. a bare
  // push-changes) — later stages must treat that as "not dispatchable", never
  // invent a message/title of their own.
  private deliveryInputFor(task: Task): DeliveryInput | undefined {
    if (task.type === "create-commit") {
      return { message: task.input.message };
    }
    if (task.type === "create-pull-request") {
      return { message: task.input.title, body: task.input.body, baseBranch: task.input.baseBranch };
    }
    return undefined;
  }

  private step(order: number, goal: EngineeringGoal, rationale: string, deliveryInput?: DeliveryInput): PlanStep {
    return { order, goal, rationale, deliveryInput };
  }
}
