import { describe, expect, it } from "vitest";
import { InProgressOperationKind, type RepositoryHealthReport } from "../../git/types";
import { JournalOperationType } from "../../journal/types";
import { PreflightValidationPolicy } from "../PreflightValidationPolicy";
import { PreflightCheck } from "../types";

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

describe("PreflightValidationPolicy", () => {
  const policy = new PreflightValidationPolicy();

  it("always passes fetch, even mid-merge -- fetch never touches the working tree", () => {
    const report = baseReport({ inProgressOperation: { kind: InProgressOperationKind.Merge, detail: undefined } });
    expect(policy.validate(JournalOperationType.Fetch, report)).toEqual({ kind: "pass" });
  });

  it("blocks every mutating operation while a merge is already in progress", () => {
    const report = baseReport({ inProgressOperation: { kind: InProgressOperationKind.Merge, detail: undefined } });
    for (const operation of [
      JournalOperationType.Sync,
      JournalOperationType.Merge,
      JournalOperationType.Rebase,
      JournalOperationType.Commit,
      JournalOperationType.Push,
      JournalOperationType.SwitchBranch,
      JournalOperationType.CreateBranch,
      JournalOperationType.Discard,
    ]) {
      const verdict = policy.validate(operation, report, { branch: "x", message: "x", targetBranch: "x" });
      expect(verdict).toMatchObject({ kind: "fail", failedCheck: PreflightCheck.RepositoryStateIsClean });
    }
  });

  it("blocks sync/rebase/merge on a detached HEAD", () => {
    const report = baseReport({ detachedHead: true });
    expect(policy.validate(JournalOperationType.Sync, report)).toMatchObject({ failedCheck: PreflightCheck.NotDetachedHead });
    expect(policy.validate(JournalOperationType.Rebase, report)).toMatchObject({ failedCheck: PreflightCheck.NotDetachedHead });
    expect(policy.validate(JournalOperationType.Merge, report, { targetBranch: "feature" })).toMatchObject({
      failedCheck: PreflightCheck.NotDetachedHead,
    });
  });

  it("blocks sync/rebase/merge/switch-branch on a dirty working tree", () => {
    const report = baseReport({ isClean: false, unstaged: ["a.ts"] });
    expect(policy.validate(JournalOperationType.Sync, report)).toMatchObject({ failedCheck: PreflightCheck.WorkingTreeClean });
    expect(policy.validate(JournalOperationType.SwitchBranch, report)).toMatchObject({
      failedCheck: PreflightCheck.WorkingTreeClean,
    });
  });

  it("blocks merging a branch into itself", () => {
    const report = baseReport({ branch: "feature" });
    const verdict = policy.validate(JournalOperationType.Merge, report, { targetBranch: "feature" });
    expect(verdict).toMatchObject({ kind: "fail", failedCheck: PreflightCheck.TargetNotCurrentBranch });
  });

  it("requires a non-empty commit message and actual changes to commit", () => {
    expect(policy.validate(JournalOperationType.Commit, baseReport(), { message: "" })).toMatchObject({
      failedCheck: PreflightCheck.NonEmptyCommitMessage,
    });
    expect(policy.validate(JournalOperationType.Commit, baseReport({ isClean: true }), { message: "fix" })).toMatchObject({
      failedCheck: PreflightCheck.HasChangesToCommit,
    });
    const dirtyReport = baseReport({ isClean: false, staged: ["a.ts"] });
    expect(policy.validate(JournalOperationType.Commit, dirtyReport, { message: "fix" })).toEqual({ kind: "pass" });
  });

  it("blocks push when the local branch is behind its upstream", () => {
    const report = baseReport({
      upstream: { ref: "origin/main", ahead: 0, behind: 2, diverged: false, deleted: false },
    });
    expect(policy.validate(JournalOperationType.Push, report)).toMatchObject({
      failedCheck: PreflightCheck.LocalIsFastForwardOfRemote,
    });
  });

  it("allows push when the upstream was deleted, or when local is not behind", () => {
    const deletedUpstream = baseReport({
      upstream: { ref: "origin/main", ahead: 0, behind: 5, diverged: false, deleted: true },
    });
    expect(policy.validate(JournalOperationType.Push, deletedUpstream)).toEqual({ kind: "pass" });

    const notBehind = baseReport({
      upstream: { ref: "origin/main", ahead: 3, behind: 0, diverged: false, deleted: false },
    });
    expect(policy.validate(JournalOperationType.Push, notBehind)).toEqual({ kind: "pass" });
  });

  it("never blocks create-branch or discard on a dirty tree", () => {
    const report = baseReport({ isClean: false, unstaged: ["a.ts"] });
    expect(policy.validate(JournalOperationType.CreateBranch, report)).toEqual({ kind: "pass" });
    expect(policy.validate(JournalOperationType.Discard, report)).toEqual({ kind: "pass" });
  });
});
