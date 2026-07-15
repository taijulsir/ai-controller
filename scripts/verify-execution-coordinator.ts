import { ExecutionCoordinator } from "../src/coordination/ExecutionCoordinator";
import type { Capability } from "../src/coordination/types";
import type { ExecutionPlan, PlanStep } from "../src/planning/types";
import type { Task } from "../src/planner/types";
import type { RecommendedAction, TaskExecutionStrategy } from "../src/strategy/types";

function baseStrategy(recommendedAction: RecommendedAction, overrides: Partial<TaskExecutionStrategy> = {}): TaskExecutionStrategy {
  return {
    repositoryId: "alpha",
    taskType: "implement-feature",
    sessionPolicy: { action: "start-new", reason: "no-active-session" },
    contextPolicy: { includeRelevantHistory: false, relevantHistoryCount: 0, warnings: [] },
    executionPriority: "normal",
    approvalExpectation: { expected: false },
    recommendedAction,
    executionReadiness: { ready: true, blockers: [] },
    safetyRecommendations: [],
    generatedAt: new Date(),
    ...overrides,
  };
}

function plan(task: Task, strategy: TaskExecutionStrategy, steps: PlanStep[]): ExecutionPlan {
  return { repositoryId: "alpha", task, strategy, steps, generatedAt: new Date() };
}

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

function capabilitiesOf(program: { steps: { capability: Capability }[] }): Capability[] {
  return program.steps.map((s) => s.capability);
}

function main(): void {
  const coordinator = new ExecutionCoordinator();

  // ShipChanges plan -> single DeliverIntegratedChange goal maps to a single
  // IntegratedDelivery capability, no sequence detection involved. Also
  // proves deliveryInput is carried forward unchanged, not recomputed from
  // plan.task (which here is a bare push-changes, carrying nothing usable —
  // if ExecutionCoordinator re-derived instead of relaying, this would fail).
  {
    const strategy = baseStrategy("ShipChanges", { taskType: "push-changes" });
    const deliveryInput = { message: "Fix bug", body: "details", baseBranch: "main" };
    const executionPlan = plan({ type: "push-changes" }, strategy, [
      { order: 1, goal: "DeliverIntegratedChange", rationale: "r1", deliveryInput },
    ]);
    const program = coordinator.buildProgram(executionPlan);
    assert(
      JSON.stringify(capabilitiesOf(program)) === JSON.stringify(["IntegratedDelivery"]),
      "ShipChanges goal maps 1:1 to [IntegratedDelivery]",
    );
    assert(program.steps[0].deliveryInput === deliveryInput, "deliveryInput carried forward as the exact same object, not recomputed");
    assert(program.steps.every((s, i) => s.order === i + 1), "steps preserve plan order");
    assert(program.steps[0].rationale === "r1", "rationale is carried through from the originating PlanStep");
    assert(program.plan === executionPlan, "CapabilityProgram.plan is the originating ExecutionPlan, unchanged");
    assert(program.repositoryId === "alpha", "repositoryId matches the plan");
  }

  // AwaitApproval originating from push-changes -> PublishRepository (no approval-specific capability)
  {
    const strategy = baseStrategy("WaitForApproval", { approvalExpectation: { expected: true, reason: "policy" } });
    const executionPlan = plan({ type: "push-changes" }, strategy, [
      { order: 1, goal: "AwaitApproval", rationale: "policy" },
    ]);
    const program = coordinator.buildProgram(executionPlan);
    assert(program.steps[0].capability === "PublishRepository", "AwaitApproval + push-changes -> PublishRepository");
  }

  // AwaitApproval originating from create-pull-request -> RequestIntegration
  {
    const strategy = baseStrategy("WaitForApproval", { approvalExpectation: { expected: true, reason: "policy" } });
    const executionPlan = plan({ type: "create-pull-request", input: { title: "t" } }, strategy, [
      { order: 1, goal: "AwaitApproval", rationale: "policy" },
    ]);
    const program = coordinator.buildProgram(executionPlan);
    assert(program.steps[0].capability === "RequestIntegration", "AwaitApproval + create-pull-request -> RequestIntegration");
  }

  // No approval-related capability exists anywhere in the Capability type's
  // meaningful outputs — spot-check across every other goal too.
  {
    const cases: { task: Task; goal: PlanStep["goal"]; expected: Capability }[] = [
      { task: { type: "analyze-repository" }, goal: "VerifyRepositoryReadiness", expected: "VerifyRepository" },
      { task: { type: "implement-feature", input: { description: "x" } }, goal: "ContinueImplementation", expected: "ContinueImplementation" },
      { task: { type: "implement-feature", input: { description: "x" } }, goal: "CreateFeatureBranch", expected: "BranchManagement" },
      { task: { type: "push-changes" }, goal: "AwaitHumanReview", expected: "HumanReview" },
    ];
    for (const { task, goal, expected } of cases) {
      const strategy = baseStrategy("AnalyzeFirst");
      const executionPlan = plan(task, strategy, [{ order: 1, goal, rationale: "r" }]);
      const program = coordinator.buildProgram(executionPlan);
      assert(program.steps[0].capability === expected, `${goal} -> ${expected}`);
    }
  }

  // CreateFeatureBranch plan -> [BranchManagement, ContinueImplementation], preserving order
  {
    const strategy = baseStrategy("CreateFeatureBranch");
    const executionPlan = plan({ type: "fix-bug", input: { description: "y" } }, strategy, [
      { order: 1, goal: "CreateFeatureBranch", rationale: "r1" },
      { order: 2, goal: "ContinueImplementation", rationale: "r2" },
    ]);
    const program = coordinator.buildProgram(executionPlan);
    assert(
      JSON.stringify(capabilitiesOf(program)) === JSON.stringify(["BranchManagement", "ContinueImplementation"]),
      "CreateFeatureBranch plan -> [BranchManagement, ContinueImplementation] in order",
    );
  }
}

main();
