import { describe, expect, it } from "vitest";
import type { IConfigService } from "../../config/interfaces";
import type { ControllerConfig } from "../../config/types";
import { InProgressOperationKind, type RepositoryHealthReport } from "../../git/types";
import { JournalOperationType } from "../../journal/types";
import { AutomaticSafetyPolicies } from "../AutomaticSafetyPolicies";
import { DivergenceStrategy, OperationClassification } from "../types";

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

function fakeConfigService(controllerConfig: Partial<ControllerConfig> = {}): IConfigService {
  const config: ControllerConfig = {
    controller: { name: "test", version: "0.0.0", environment: "test" },
    workspace: { root: "/tmp" },
    task: { max_concurrent_jobs: 1, timeout_minutes: 10 },
    approval: { mode: "manual" },
    logging: { enabled: false, level: "info", directory: "/tmp" },
    memory: { enabled: false, directory: "/tmp" },
    ...controllerConfig,
  };
  return {
    getControllerConfig: () => config,
    getClaudeConfig: () => {
      throw new Error("not needed");
    },
    getGithubConfig: () => {
      throw new Error("not needed");
    },
    getTelegramConfig: () => {
      throw new Error("not needed");
    },
    getRepositories: () => [],
    reload: () => {},
  };
}

describe("AutomaticSafetyPolicies", () => {
  it("recommends recovery when an operation is in progress, except for fetch", () => {
    const policies = new AutomaticSafetyPolicies(fakeConfigService());
    const report = baseReport({ inProgressOperation: { kind: InProgressOperationKind.Merge, detail: undefined } });
    expect(policies.classify(JournalOperationType.Sync, report)).toBe(OperationClassification.RecommendRecovery);
    expect(policies.classify(JournalOperationType.Fetch, report)).not.toBe(OperationClassification.RecommendRecovery);
  });

  it("recommends recovery for an interrupted operation too", () => {
    const policies = new AutomaticSafetyPolicies(fakeConfigService());
    const report = baseReport({ interruptedOperation: { kind: InProgressOperationKind.Rebase, journalEntryId: undefined } });
    expect(policies.classify(JournalOperationType.Commit, report)).toBe(OperationClassification.RecommendRecovery);
  });

  it("always requires approval for rebase, regardless of config", () => {
    const policies = new AutomaticSafetyPolicies(fakeConfigService());
    expect(policies.classify(JournalOperationType.Rebase, baseReport())).toBe(OperationClassification.RequestApproval);
  });

  // Regression coverage: classify() previously re-checked approval.require_before
  // (and the legacy require_before_git_push) itself, which duplicated
  // ApprovalPolicy/ApprovalEngine's own identical check on the same config
  // field -- every /merge or /push under the shipped default config produced
  // two sequential Telegram approval prompts for one command. classify() must
  // now stay ContinueAutomatically for config-driven operations regardless of
  // require_before, since ApprovalEngine (the outer gate, which every
  // Command Orchestrator caller is guaranteed to already have passed through)
  // owns that decision exclusively. Only the hardcoded floor
  // (HARDCODED_APPROVAL_OPERATIONS) may still push this layer to
  // RequestApproval on its own.
  it("does not request approval for push based on require_before_git_push (legacy config) -- avoids double-gating with ApprovalEngine", () => {
    const policies = new AutomaticSafetyPolicies(fakeConfigService({ approval: { mode: "manual", require_before_git_push: true } }));
    expect(policies.classify(JournalOperationType.Push, baseReport())).toBe(OperationClassification.ContinueAutomatically);
  });

  it("does not request approval for merge based on require_before (new config) -- avoids double-gating with ApprovalEngine", () => {
    const policies = new AutomaticSafetyPolicies(fakeConfigService({ approval: { mode: "manual", require_before: ["merge"] } }));
    expect(policies.classify(JournalOperationType.Merge, baseReport())).toBe(OperationClassification.ContinueAutomatically);
  });

  it("does not request approval for discard even when require_before lists it -- config-driven gating is ApprovalEngine's job alone", () => {
    const policies = new AutomaticSafetyPolicies(fakeConfigService({ approval: { mode: "manual", require_before: ["discard"] } }));
    expect(policies.classify(JournalOperationType.Discard, baseReport())).toBe(OperationClassification.ContinueAutomatically);
  });

  it("still requires approval for rebase even when require_before is empty -- the hardcoded floor never depends on config", () => {
    const policies = new AutomaticSafetyPolicies(fakeConfigService({ approval: { mode: "manual", require_before: [] } }));
    expect(policies.classify(JournalOperationType.Rebase, baseReport())).toBe(OperationClassification.RequestApproval);
  });

  it("continues automatically for sync/commit/fetch/push/merge/discard by default", () => {
    const policies = new AutomaticSafetyPolicies(fakeConfigService());
    for (const operation of [
      JournalOperationType.Sync,
      JournalOperationType.Commit,
      JournalOperationType.Fetch,
      JournalOperationType.Push,
      JournalOperationType.Merge,
      JournalOperationType.Discard,
    ]) {
      expect(policies.classify(operation, baseReport())).toBe(OperationClassification.ContinueAutomatically);
    }
  });

  it("divergenceStrategy defaults to rebase, and reads config when present", () => {
    expect(new AutomaticSafetyPolicies(fakeConfigService()).divergenceStrategy("repo-1")).toBe(DivergenceStrategy.Rebase);
    expect(
      new AutomaticSafetyPolicies(fakeConfigService({ git_orchestration: { divergence_strategy: "ask" } })).divergenceStrategy("repo-1"),
    ).toBe(DivergenceStrategy.Ask);
    expect(
      new AutomaticSafetyPolicies(fakeConfigService({ git_orchestration: { divergence_strategy: "merge" } })).divergenceStrategy("repo-1"),
    ).toBe(DivergenceStrategy.Merge);
  });
});
