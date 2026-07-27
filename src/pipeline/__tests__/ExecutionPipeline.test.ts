import { describe, expect, it } from "vitest";
import type { IExecutionCoordinator } from "../../coordination/interfaces";
import { ExecutionCoordinator } from "../../coordination/ExecutionCoordinator";
import type { IControllerCore } from "../../controller/interfaces";
import type { ExecutionRequest, ExecutionResult } from "../../controller/types";
import type { IRepositoryIntelligenceService } from "../../intelligence/interfaces";
import type { RepositorySnapshot } from "../../intelligence/types";
import type { IPipelineBlockRecorder } from "../../memory/interfaces";
import type { PipelineBlockDetails } from "../../memory/types";
import type { IPlanningEngine } from "../../planning/interfaces";
import { PlanningEngine } from "../../planning/PlanningEngine";
import type { IExecutionStrategyEngine } from "../../strategy/interfaces";
import type { TaskExecutionStrategy } from "../../strategy/types";
import { ExecutionPipeline } from "../ExecutionPipeline";

function fakeSnapshot(overrides: Partial<RepositorySnapshot["branch"]> = {}): RepositorySnapshot {
  return {
    repository: { id: "gcpay-backend", name: "GCPay Backend", path: "/tmp/gcpay-backend", defaultBranch: "production_2026_mall", active: true },
    branch: { current: "production_2026_mall", default: "production_2026_mall", ahead: 0, behind: 0, ...overrides },
    branches: ["production_2026_mall"],
    workingTree: { isClean: true, staged: [], unstaged: [], untracked: [] },
    recentCommits: [],
    pullRequests: { open: [], openCount: 0 },
    health: { isGitRepository: true, isClean: true, hasUnpushedCommits: false, isBehindRemote: false, hasOpenPullRequests: false, issues: [] },
    workflowReadiness: { canShip: true, requiresApprovalBeforePush: false, requiresApprovalBeforePullRequest: false, blockers: [] },
    generatedAt: new Date(),
  };
}

function fakeIntelligence(snapshot: RepositorySnapshot): IRepositoryIntelligenceService {
  return { getSnapshot: async () => snapshot };
}

function fakeStrategyEngine(recommendedAction: TaskExecutionStrategy["recommendedAction"]): IExecutionStrategyEngine {
  return {
    recommend: async ({ task }): Promise<TaskExecutionStrategy> => ({
      repositoryId: "gcpay-backend",
      taskType: task.type,
      sessionPolicy: { action: "start-new", reason: "no-active-session" },
      contextPolicy: { includeRelevantHistory: false, relevantHistoryCount: 0, warnings: [] },
      executionPriority: recommendedAction === "ReviewRepository" ? "blocked" : "normal",
      approvalExpectation: { expected: false },
      recommendedAction,
      executionReadiness: recommendedAction === "ReviewRepository" ? { ready: false, blockers: ["a critical insight"] } : { ready: true, blockers: [] },
      safetyRecommendations: [],
      generatedAt: new Date(),
    }),
  };
}

function fakeControllerCore(): IControllerCore {
  return {
    execute: async (): Promise<ExecutionResult> => {
      throw new Error("ControllerCore.execute() must never be called for a blocked pipeline step.");
    },
  };
}

function recordingRecorder(): { recorder: IPipelineBlockRecorder; calls: Array<{ repositoryId: string; details: PipelineBlockDetails }> } {
  const calls: Array<{ repositoryId: string; details: PipelineBlockDetails }> = [];
  return {
    recorder: {
      recordPipelineBlock: async (repositoryId, details) => {
        calls.push({ repositoryId, details });
      },
    },
    calls,
  };
}

function buildPipeline(deps: {
  snapshot: RepositorySnapshot;
  recommendedAction: TaskExecutionStrategy["recommendedAction"];
  pipelineBlockRecorder: IPipelineBlockRecorder;
  controllerCore?: IControllerCore;
}): ExecutionPipeline {
  const planningEngine: IPlanningEngine = new PlanningEngine();
  const executionCoordinator: IExecutionCoordinator = new ExecutionCoordinator();
  return new ExecutionPipeline(
    fakeIntelligence(deps.snapshot),
    fakeStrategyEngine(deps.recommendedAction),
    planningEngine,
    executionCoordinator,
    deps.controllerCore ?? fakeControllerCore(),
    deps.pipelineBlockRecorder,
  );
}

// Branch Blocking Observability: every "blocked" DispatchDecision (today:
// BranchManagement from a "CreateFeatureBranch" recommendation, HumanReview
// from a "ReviewRepository" recommendation) must produce exactly one audit
// record, carrying the exact repository/branch/decision context that was
// evaluated -- and must never affect what ControllerCore.execute() is asked
// to do (it must never be called at all for a blocked step).
describe("ExecutionPipeline — blocked-decision audit recording", () => {
  it("records a BranchManagement block with the evaluated branch state", async () => {
    const snapshot = fakeSnapshot({ current: "production_2026_mall", default: "production_2026_mall" });
    const { recorder, calls } = recordingRecorder();
    const pipeline = buildPipeline({ snapshot, recommendedAction: "CreateFeatureBranch", pipelineBlockRecorder: recorder });

    const result = await pipeline.run({ kind: "task", task: { type: "fix-bug", input: { description: "fix cron" } }, repositoryId: "gcpay-backend" });

    expect(calls).toHaveLength(1);
    expect(calls[0].repositoryId).toBe("gcpay-backend");
    expect(calls[0].details.taskType).toBe("fix-bug");
    expect(calls[0].details.pipelineStage).toBe("BranchManagement");
    expect(calls[0].details.currentBranch).toBe("production_2026_mall");
    expect(calls[0].details.defaultBranch).toBe("production_2026_mall");
    expect(calls[0].details.blockingReason).toContain("feature branch is required");
    expect(calls[0].details.recommendedAction).toContain("git checkout -b");
    expect(calls[0].details.decisionSummary).toContain("CreateFeatureBranch");
    expect(calls[0].details.decisionSummary).toContain("BranchManagement");

    expect(result.path).toBe("full");
    if (result.path === "full") {
      expect(result.stepOutcomes).toHaveLength(1);
      expect(result.stepOutcomes[0].status).toBe("blocked");
    }
  });

  it("records a HumanReview block distinctly from a BranchManagement block", async () => {
    const snapshot = fakeSnapshot({ current: "mall_international_delivery_2026", default: "production_2026_mall" });
    const { recorder, calls } = recordingRecorder();
    const pipeline = buildPipeline({ snapshot, recommendedAction: "ReviewRepository", pipelineBlockRecorder: recorder });

    await pipeline.run({ kind: "task", task: { type: "fix-bug", input: { description: "fix cron" } }, repositoryId: "gcpay-backend" });

    expect(calls).toHaveLength(1);
    expect(calls[0].details.pipelineStage).toBe("HumanReview");
    expect(calls[0].details.currentBranch).toBe("mall_international_delivery_2026");
    expect(calls[0].details.defaultBranch).toBe("production_2026_mall");
  });

  it("never calls ControllerCore.execute() for a blocked step", async () => {
    const snapshot = fakeSnapshot({ current: "production_2026_mall", default: "production_2026_mall" });
    const { recorder } = recordingRecorder();
    const pipeline = buildPipeline({ snapshot, recommendedAction: "CreateFeatureBranch", pipelineBlockRecorder: recorder });

    // fakeControllerCore() throws if execute() is ever called -- run()
    // resolving without throwing is itself the assertion.
    await expect(
      pipeline.run({ kind: "task", task: { type: "fix-bug", input: { description: "fix cron" } }, repositoryId: "gcpay-backend" }),
    ).resolves.toBeDefined();
  });

  it("does not affect the returned PipelineResult when the audit write itself fails", async () => {
    const snapshot = fakeSnapshot({ current: "production_2026_mall", default: "production_2026_mall" });
    const failingRecorder: IPipelineBlockRecorder = {
      recordPipelineBlock: async () => {
        throw new Error("disk full");
      },
    };
    const pipeline = buildPipeline({ snapshot, recommendedAction: "CreateFeatureBranch", pipelineBlockRecorder: failingRecorder });

    const result = await pipeline.run({ kind: "task", task: { type: "fix-bug", input: { description: "fix cron" } }, repositoryId: "gcpay-backend" });

    expect(result.path).toBe("full");
    if (result.path === "full") {
      expect(result.stepOutcomes[0].status).toBe("blocked");
    }
  });

  it("never records anything for a task type that dispatches successfully (no block)", async () => {
    const snapshot = fakeSnapshot({ current: "feature/anything", default: "production_2026_mall" });
    const { recorder, calls } = recordingRecorder();
    const controllerCore: IControllerCore = {
      execute: async (request: ExecutionRequest): Promise<ExecutionResult> => ({
        kind: "task",
        taskResult: { taskType: request.kind === "task" ? request.task.type : "analyze-repository", success: true, correlationId: "c1" } as never,
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 1,
      }),
    };
    const pipeline = buildPipeline({ snapshot, recommendedAction: "ContinueCurrentTask", pipelineBlockRecorder: recorder, controllerCore });

    await pipeline.run({ kind: "task", task: { type: "fix-bug", input: { description: "fix cron" } }, repositoryId: "gcpay-backend" });

    expect(calls).toHaveLength(0);
  });
});
