import { describe, expect, it } from "vitest";
import { InProgressOperationKind, type RepositoryHealthReport } from "../../git/types";
import { RepositoryStateAnalyzer } from "../RepositoryStateAnalyzer";
import { RepositoryState } from "../types";

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

describe("RepositoryStateAnalyzer", () => {
  const analyzer = new RepositoryStateAnalyzer();

  it("classifies a clean report as Clean", () => {
    expect(analyzer.classify(baseReport())).toBe(RepositoryState.Clean);
  });

  it("classifies a dirty working tree as Dirty", () => {
    expect(analyzer.classify(baseReport({ isClean: false, unstaged: ["a.ts"] }))).toBe(RepositoryState.Dirty);
  });

  it("classifies a diverged upstream as Diverged", () => {
    const report = baseReport({
      upstream: { ref: "origin/main", ahead: 2, behind: 3, diverged: true, deleted: false },
    });
    expect(analyzer.classify(report)).toBe(RepositoryState.Diverged);
  });

  it("classifies detached HEAD as DetachedHead, even with a dirty tree", () => {
    const report = baseReport({ detachedHead: true, isClean: false, unstaged: ["a.ts"] });
    expect(analyzer.classify(report)).toBe(RepositoryState.DetachedHead);
  });

  it("maps each in-progress operation kind to its matching state", () => {
    const cases: Array<[InProgressOperationKind, RepositoryState]> = [
      [InProgressOperationKind.Merge, RepositoryState.MergeInProgress],
      [InProgressOperationKind.Rebase, RepositoryState.RebaseInProgress],
      [InProgressOperationKind.CherryPick, RepositoryState.CherryPickInProgress],
      [InProgressOperationKind.Revert, RepositoryState.RevertInProgress],
      [InProgressOperationKind.Bisect, RepositoryState.BisectInProgress],
    ];
    for (const [kind, expected] of cases) {
      const report = baseReport({ inProgressOperation: { kind, detail: undefined } });
      expect(analyzer.classify(report)).toBe(expected);
    }
  });

  it("prioritizes an in-progress operation over detached HEAD and divergence", () => {
    const report = baseReport({
      detachedHead: true,
      upstream: { ref: "origin/main", ahead: 0, behind: 0, diverged: true, deleted: false },
      inProgressOperation: { kind: InProgressOperationKind.Rebase, detail: undefined },
    });
    expect(analyzer.classify(report)).toBe(RepositoryState.RebaseInProgress);
  });

  it("prioritizes an interrupted operation over everything else, including a plain in-progress one", () => {
    const report = baseReport({
      inProgressOperation: { kind: InProgressOperationKind.Merge, detail: undefined },
      interruptedOperation: { kind: InProgressOperationKind.Merge, journalEntryId: undefined },
    });
    expect(analyzer.classify(report)).toBe(RepositoryState.Recovering);
  });

  it("never produces Unrecoverable -- that judgment belongs to Recovery Planner", () => {
    for (const overrides of [{}, { isClean: false }, { detachedHead: true }]) {
      expect(analyzer.classify(baseReport(overrides))).not.toBe(RepositoryState.Unrecoverable);
    }
  });
});
