import { describe, expect, it } from "vitest";
import type { ControllerConfig } from "../../config/types";
import type { Task } from "../../planner/types";
import { ApprovalPolicy } from "../ApprovalPolicy";

function config(overrides: Partial<ControllerConfig["approval"]> = {}): ControllerConfig {
  return {
    controller: { name: "test", version: "0.0.0", environment: "test" },
    workspace: { root: "/tmp" },
    task: { max_concurrent_jobs: 1, timeout_minutes: 10 },
    approval: { mode: "manual", ...overrides },
    logging: { enabled: false, level: "info", directory: "/tmp" },
    memory: { enabled: false, directory: "/tmp" },
  };
}

describe("ApprovalPolicy", () => {
  // Now that AutomaticSafetyPolicies no longer independently re-checks
  // require_before (see its own test file's regression coverage), this is
  // the ONLY place approval.require_before is consulted for a config-driven
  // command -- including ones AutomaticSafetyPolicies never had a
  // task-type mapping for at all, like "discard". Confirms the config
  // comment's own promise ("add an entry here to gate a newly-introduced
  // command, without any code or schema change") actually holds for every
  // task type, not just merge/push.
  it("gates discard when require_before lists it, even though no other layer maps discard to a config key", () => {
    const policy = new ApprovalPolicy();
    const task: Task = { type: "discard" };
    expect(policy.requiresApproval(task, config({ require_before: ["discard"] }))).toBe(true);
  });

  it("does not gate discard when require_before omits it", () => {
    const policy = new ApprovalPolicy();
    const task: Task = { type: "discard" };
    expect(policy.requiresApproval(task, config({ require_before: ["merge"] }))).toBe(false);
  });

  it("still gates merge and push-changes via require_before", () => {
    const policy = new ApprovalPolicy();
    expect(policy.requiresApproval({ type: "merge", input: { branch: "main" } }, config({ require_before: ["merge"] }))).toBe(true);
    expect(policy.requiresApproval({ type: "push-changes" }, config({ require_before: ["push-changes"] }))).toBe(true);
  });

  it("never requires approval outside manual mode", () => {
    const policy = new ApprovalPolicy();
    const task: Task = { type: "discard" };
    expect(policy.requiresApproval(task, config({ mode: "auto", require_before: ["discard"] }))).toBe(false);
  });
});
