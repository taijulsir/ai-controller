import type { RepositorySnapshot } from "../src/intelligence/types";
import type { Task } from "../src/planner/types";
import { PlanningEngine } from "../src/planning/PlanningEngine";
import type { EngineeringGoal } from "../src/planning/types";
import type { RecommendedAction, TaskExecutionStrategy } from "../src/strategy/types";

function baseSnapshot(overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
  return {
    repository: { id: "alpha", name: "alpha", path: "/tmp/alpha", defaultBranch: "main", active: true },
    branch: { current: "main", default: "main", ahead: 0, behind: 0 },
    workingTree: { isClean: true, staged: [], unstaged: [], untracked: [] },
    recentCommits: [],
    pullRequests: { open: [], openCount: 0 },
    health: { isGitRepository: true, isClean: true, hasUnpushedCommits: false, isBehindRemote: false, hasOpenPullRequests: false, issues: [] },
    workflowReadiness: { canShip: true, requiresApprovalBeforePush: false, requiresApprovalBeforePullRequest: false, blockers: [] },
    generatedAt: new Date(),
    ...overrides,
  };
}

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

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

function goalsOf(steps: { goal: EngineeringGoal }[]): EngineeringGoal[] {
  return steps.map((s) => s.goal);
}

function isOrdered(steps: { order: number }[]): boolean {
  return steps.every((step, index) => step.order === index + 1);
}

function main(): void {
  const engine = new PlanningEngine();
  const implementTask: Task = { type: "implement-feature", input: { description: "add x" } };

  // ReviewRepository -> single AwaitHumanReview step
  {
    const strategy = baseStrategy("ReviewRepository", { executionReadiness: { ready: false, blockers: ["not a git repository"] } });
    const plan = engine.buildPlan({ task: implementTask, strategy, repository: baseSnapshot() });
    assert(JSON.stringify(goalsOf(plan.steps)) === JSON.stringify(["AwaitHumanReview"]), "ReviewRepository -> [AwaitHumanReview]");
    assert(plan.steps[0].rationale.includes("not a git repository"), "AwaitHumanReview rationale surfaces the blocker");
    assert(isOrdered(plan.steps), "steps are ordered 1..n");
  }

  // WaitForApproval -> single AwaitApproval step
  {
    const strategy = baseStrategy("WaitForApproval", { approvalExpectation: { expected: true, reason: "push-changes requires approval under the current approval policy" } });
    const plan = engine.buildPlan({ task: { type: "push-changes" }, strategy, repository: baseSnapshot() });
    assert(JSON.stringify(goalsOf(plan.steps)) === JSON.stringify(["AwaitApproval"]), "WaitForApproval -> [AwaitApproval]");
    assert(plan.steps[0].rationale.includes("approval"), "AwaitApproval rationale carries the approval reason");
  }

  // AnalyzeFirst -> single VerifyRepositoryReadiness step
  {
    const strategy = baseStrategy("AnalyzeFirst", { taskType: "analyze-repository" });
    const plan = engine.buildPlan({ task: { type: "analyze-repository" }, strategy, repository: baseSnapshot() });
    assert(JSON.stringify(goalsOf(plan.steps)) === JSON.stringify(["VerifyRepositoryReadiness"]), "AnalyzeFirst -> [VerifyRepositoryReadiness]");
  }

  // ContinueCurrentTask -> single ContinueImplementation step
  {
    const strategy = baseStrategy("ContinueCurrentTask", { sessionPolicy: { action: "continue", sessionId: "sess-1" } });
    const plan = engine.buildPlan({ task: implementTask, strategy, repository: baseSnapshot() });
    assert(JSON.stringify(goalsOf(plan.steps)) === JSON.stringify(["ContinueImplementation"]), "ContinueCurrentTask -> [ContinueImplementation]");
  }

  // CreateFeatureBranch -> ordered [CreateFeatureBranch, ContinueImplementation]
  {
    const strategy = baseStrategy("CreateFeatureBranch");
    const plan = engine.buildPlan({ task: implementTask, strategy, repository: baseSnapshot() });
    assert(
      JSON.stringify(goalsOf(plan.steps)) === JSON.stringify(["CreateFeatureBranch", "ContinueImplementation"]),
      "CreateFeatureBranch -> [CreateFeatureBranch, ContinueImplementation] in order",
    );
    assert(isOrdered(plan.steps), "steps are ordered 1..n");
  }

  // ShipChanges -> single, explicit DeliverIntegratedChange step (no goal
  // sequence to infer from — see ExecutionCoordinator/ExecutionPipeline for
  // why the "no pattern matching" requirement pushed this representation up
  // to the planning layer).
  {
    const strategy = baseStrategy("ShipChanges", { taskType: "push-changes" });
    const plan = engine.buildPlan({ task: { type: "push-changes" }, strategy, repository: baseSnapshot() });
    assert(
      JSON.stringify(goalsOf(plan.steps)) === JSON.stringify(["DeliverIntegratedChange"]),
      "ShipChanges -> [DeliverIntegratedChange]",
    );
    assert(isOrdered(plan.steps), "steps are ordered 1..n");
    assert(plan.steps[0].deliveryInput === undefined, "a bare push-changes task carries no deliveryInput — never fabricated");
  }

  // DeliverIntegratedChange captures deliveryInput from the originating Task
  // — this is the one place in the whole pipeline that information is derived;
  // every later layer (ExecutionCoordinator, ExecutionPipeline) only relays it.
  {
    const strategy = baseStrategy("ShipChanges", { taskType: "create-commit" });
    const plan = engine.buildPlan({ task: { type: "create-commit", input: { message: "Fix bug" } }, strategy, repository: baseSnapshot() });
    assert(plan.steps[0].deliveryInput?.message === "Fix bug", "create-commit task -> deliveryInput.message captured from task.input.message");
  }
  {
    const strategy = baseStrategy("ShipChanges", { taskType: "create-pull-request" });
    const plan = engine.buildPlan({
      task: { type: "create-pull-request", input: { title: "Add dark mode", body: "details", baseBranch: "develop" } },
      strategy,
      repository: baseSnapshot(),
    });
    const deliveryInput = plan.steps[0].deliveryInput;
    assert(
      deliveryInput?.message === "Add dark mode" && deliveryInput?.body === "details" && deliveryInput?.baseBranch === "develop",
      "create-pull-request task -> deliveryInput captures title as message, plus body and baseBranch",
    );
  }

  // ShipChanges with an existing open PR -> DeliverIntegratedChange rationale reflects it
  {
    const strategy = baseStrategy("ShipChanges");
    const plan = engine.buildPlan({
      task: { type: "push-changes" },
      strategy,
      repository: baseSnapshot({ pullRequests: { open: [], openCount: 2 } }),
    });
    const deliverStep = plan.steps.find((s) => s.goal === "DeliverIntegratedChange");
    assert(!!deliverStep?.rationale.includes("2 pull request"), "DeliverIntegratedChange rationale reflects existing open PR count from RepositorySnapshot");
  }

  // Traceability: originating task and strategy are carried through unchanged
  {
    const strategy = baseStrategy("ContinueCurrentTask");
    const plan = engine.buildPlan({ task: implementTask, strategy, repository: baseSnapshot() });
    assert(plan.task === implementTask, "ExecutionPlan.task is the originating Task, unchanged");
    assert(plan.strategy === strategy, "ExecutionPlan.strategy is the originating TaskExecutionStrategy, unchanged");
    assert(plan.repositoryId === "alpha", "ExecutionPlan.repositoryId matches strategy.repositoryId");
  }
}

main();
