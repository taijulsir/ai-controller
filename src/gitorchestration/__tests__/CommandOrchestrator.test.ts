import { describe, expect, it } from "vitest";
import type { IGitHealthService } from "../../git/interfaces";
import { InProgressOperationKind, type RepositoryHealthReport } from "../../git/types";
import { GitStateMachine } from "../../gitstate/GitStateMachine";
import { IllegalStateTransitionError } from "../../gitstate/errors";
import type { IRepositoryStateAnalyzer } from "../../gitstate/interfaces";
import { RepositoryState } from "../../gitstate/types";
import { JournalOperationType } from "../../journal/types";
import type { IRecoveryPlanner } from "../../recovery/interfaces";
import { RecoveryStepRisk, type RecoveryPlan } from "../../recovery/types";
import { CommandOrchestrator } from "../CommandOrchestrator";
import type { IApprovalGate, IAutomaticSafetyPolicies, IPreflightValidationPolicy } from "../interfaces";
import { DivergenceStrategy, OperationClassification } from "../types";

function report(): RepositoryHealthReport {
  return {
    repositoryId: "repo-1",
    capturedAt: new Date(),
    branch: "main",
    detachedHead: false,
    headSha: "deadbeef",
    upstream: undefined,
    staged: [],
    unstaged: [],
    untracked: [],
    isClean: true,
    inProgressOperation: { kind: InProgressOperationKind.Merge },
    stashCount: 0,
    branchProtection: undefined,
    locks: { indexLocked: false, headLocked: false, staleLockDetected: false },
    worktrees: [],
    submodules: [],
    isShallow: false,
    lfs: undefined,
    interruptedOperation: undefined,
    forcePushDetected: false,
    remoteChangedSinceLastFetch: false,
  };
}

function plan(detectedState: RepositoryState): RecoveryPlan {
  return {
    id: "plan-1",
    repositoryId: "repo-1",
    createdAt: new Date(),
    detectedState,
    summary: "test plan",
    steps: [
      { id: "step-1", description: "do something", risk: RecoveryStepRisk.Safe, requiresApproval: false, command: { kind: "abort-merge" } },
    ],
    reValidateBeforeExecution: true,
  };
}

const alwaysRecommendRecovery: IAutomaticSafetyPolicies = {
  classify: () => OperationClassification.RecommendRecovery,
  divergenceStrategy: () => DivergenceStrategy.Rebase,
};

const passthroughPreflight: IPreflightValidationPolicy = { validate: () => ({ kind: "pass" }) };
const alwaysApproveGate: IApprovalGate = { requestApproval: async () => true };
const fakeHealthService: IGitHealthService = { getHealth: async () => report() };

function fakeStateAnalyzer(state: RepositoryState): IRepositoryStateAnalyzer {
  return { classify: () => state };
}

function fakeRecoveryPlanner(detectedState: RepositoryState): IRecoveryPlanner {
  return { plan: () => plan(detectedState) };
}

// Regression coverage for the finding that Git State Machine (component 18)
// was built but never wired into Command Orchestrator, despite its own doc
// comment claiming it was "the one caller... that must fail loudly rather
// than silently ignore an illegal transition."
describe("CommandOrchestrator + Git State Machine wiring", () => {
  it("fails loudly instead of returning a recovery plan for a state with no legal transition to Recovering", async () => {
    const orchestrator = new CommandOrchestrator(
      fakeHealthService,
      alwaysRecommendRecovery,
      passthroughPreflight,
      fakeRecoveryPlanner(RepositoryState.Unrecoverable),
      alwaysApproveGate,
      fakeStateAnalyzer(RepositoryState.Unrecoverable),
      new GitStateMachine(),
    );

    await expect(
      orchestrator.execute({
        operation: JournalOperationType.Commit,
        repositoryId: "repo-1",
        correlationId: "corr-1",
        run: async () => "should never run",
      }),
    ).rejects.toBeInstanceOf(IllegalStateTransitionError);
  });

  it("still returns a normal recovery plan for a legal transition (e.g. MergeInProgress -> Recovering)", async () => {
    const orchestrator = new CommandOrchestrator(
      fakeHealthService,
      alwaysRecommendRecovery,
      passthroughPreflight,
      fakeRecoveryPlanner(RepositoryState.MergeInProgress),
      alwaysApproveGate,
      fakeStateAnalyzer(RepositoryState.MergeInProgress),
      new GitStateMachine(),
    );

    const result = await orchestrator.execute({
      operation: JournalOperationType.Commit,
      repositoryId: "repo-1",
      correlationId: "corr-1",
      run: async () => "should never run",
    });

    expect(result.kind).toBe("recommend-recovery");
  });

  it("does not treat already-Recovering as a transition (no false-positive throw)", async () => {
    const orchestrator = new CommandOrchestrator(
      fakeHealthService,
      alwaysRecommendRecovery,
      passthroughPreflight,
      fakeRecoveryPlanner(RepositoryState.Recovering),
      alwaysApproveGate,
      fakeStateAnalyzer(RepositoryState.Recovering),
      new GitStateMachine(),
    );

    const result = await orchestrator.execute({
      operation: JournalOperationType.Commit,
      repositoryId: "repo-1",
      correlationId: "corr-1",
      run: async () => "should never run",
    });

    expect(result.kind).toBe("recommend-recovery");
  });
});
