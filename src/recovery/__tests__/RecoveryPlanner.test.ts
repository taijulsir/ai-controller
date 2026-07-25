import { describe, expect, it } from "vitest";
import { InProgressOperationKind, type RepositoryHealthReport } from "../../git/types";
import { RepositoryState } from "../../gitstate/types";
import type { IRepositoryStateAnalyzer } from "../../gitstate/interfaces";
import { RecoveryPlanner } from "../RecoveryPlanner";
import { RecoveryStepRisk } from "../types";

function baseReport(overrides: Partial<RepositoryHealthReport> = {}): RepositoryHealthReport {
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
    inProgressOperation: undefined,
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
    ...overrides,
  };
}

function stubAnalyzer(state: RepositoryState): IRepositoryStateAnalyzer {
  return { classify: () => state };
}

describe("RecoveryPlanner", () => {
  it("returns undefined for Clean, Dirty, and Diverged -- normal operating states", () => {
    for (const state of [RepositoryState.Clean, RepositoryState.Dirty, RepositoryState.Diverged]) {
      const planner = new RecoveryPlanner(stubAnalyzer(state));
      expect(planner.plan(baseReport())).toBeUndefined();
    }
  });

  it("builds a single safe abort-merge step for MergeInProgress", () => {
    const planner = new RecoveryPlanner(stubAnalyzer(RepositoryState.MergeInProgress));
    const plan = planner.plan(baseReport());
    expect(plan).toBeDefined();
    expect(plan!.detectedState).toBe(RepositoryState.MergeInProgress);
    expect(plan!.reValidateBeforeExecution).toBe(true);
    expect(plan!.steps).toHaveLength(1);
    expect(plan!.steps[0]).toMatchObject({ risk: RecoveryStepRisk.Safe, requiresApproval: false, command: { kind: "abort-merge" } });
  });

  it("prepends a requires-approval stale-lock removal step before the abort step", () => {
    const planner = new RecoveryPlanner(stubAnalyzer(RepositoryState.RebaseInProgress));
    const report = baseReport({ locks: { indexLocked: true, headLocked: false, staleLockDetected: true } });
    const plan = planner.plan(report)!;
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]).toMatchObject({ risk: RecoveryStepRisk.Irreversible, requiresApproval: true, command: { kind: "remove-stale-lock" } });
    expect(plan.steps[1]).toMatchObject({ command: { kind: "abort-rebase" } });
  });

  it("recommends a branch-at-head step for DetachedHead, never requiring approval", () => {
    const planner = new RecoveryPlanner(stubAnalyzer(RepositoryState.DetachedHead));
    const plan = planner.plan(baseReport())!;
    expect(plan.steps).toEqual([
      expect.objectContaining({ risk: RecoveryStepRisk.Safe, requiresApproval: false, command: { kind: "create-branch-at-head" } }),
    ]);
  });

  it("dispatches Recovering's interrupted-operation kind to the matching abort step", () => {
    const planner = new RecoveryPlanner(stubAnalyzer(RepositoryState.Recovering));
    const report = baseReport({ interruptedOperation: { kind: InProgressOperationKind.CherryPick, journalEntryId: undefined } });
    const plan = planner.plan(report)!;
    expect(plan.steps).toEqual([expect.objectContaining({ command: { kind: "abort-cherry-pick" } })]);
  });

  it("recommends a re-clone for Unrecoverable, gated behind approval", () => {
    const planner = new RecoveryPlanner(stubAnalyzer(RepositoryState.Unrecoverable));
    const plan = planner.plan(baseReport())!;
    expect(plan.steps).toEqual([
      expect.objectContaining({ risk: RecoveryStepRisk.Irreversible, requiresApproval: true, command: { kind: "recommend-reclone" } }),
    ]);
  });
});
