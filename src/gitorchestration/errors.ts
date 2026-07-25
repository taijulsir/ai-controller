import { GitOrchestrationError } from "../gitstate/errors";
import type { RecoveryPlan } from "../recovery/types";
import type { PreflightVerdict } from "./types";

export class PreflightValidationFailedError extends GitOrchestrationError {
  constructor(public readonly verdict: Extract<PreflightVerdict, { kind: "fail" }>) {
    super(verdict.reason);
    this.name = "PreflightValidationFailedError";
  }
}

export class OperationRequiresRecoveryError extends GitOrchestrationError {
  constructor(public readonly plan: RecoveryPlan) {
    super(`Repository is in "${plan.detectedState}" -- run /recover before retrying this command.`);
    this.name = "OperationRequiresRecoveryError";
  }
}

// Same DI-seam shape as DeferredApprovalPendingReader (src/approval): the
// real approval gate needs a Telegram client/security instance built later
// in src/index.ts, but Command Orchestrator, the Engines, Recovery
// Workflow, and Safe Undo Framework all need an IApprovalGate at their own
// construction time. bind() must run before any of those can be invoked.
// Thrown by the planner-workflow gateway (src/planner/workflows/
// gitOrchestrationSupport.ts) when Command Orchestrator reports
// "awaiting-approval" -- i.e. the approval gate resolved to false (declined
// or timed out). Distinct from PreflightValidationFailedError: the
// repository state was fine, an operator (or the timeout) said no.
export class ApprovalDeclinedError extends GitOrchestrationError {
  constructor(public readonly correlationId: string) {
    super("This operation requires approval, and it was not granted (declined or timed out).");
    this.name = "ApprovalDeclinedError";
  }
}

export class ApprovalGateNotBoundError extends Error {
  constructor() {
    super("DeferredApprovalGate.requestApproval() was called before bind() wired it to the real approval gate.");
    this.name = "ApprovalGateNotBoundError";
  }
}
