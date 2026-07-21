import type { ControllerConfig } from "../config/types";
import type { Task } from "../planner/types";
import type { ApprovalDecision, ApprovalRequest } from "./types";

export interface IApprovalProvider {
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface IApprovalPolicy {
  requiresApproval(task: Task, controllerConfig: ControllerConfig): boolean;
}

// Narrow read-only view over TelegramApprovalProvider's own pending-approval
// state -- carved out the same way IAutonomousPlanScheduleProvider/
// IRecentExecutionHistoryProvider narrow IApplicationService's own
// dependents: a consumer whose only legitimate need is "is this
// correlationId currently awaiting approval" never gains type-level access
// to requestApproval() (which would let it originate an approval prompt) or
// ITelegramCallbackHandler.
export interface IApprovalPendingReader {
  isPending(correlationId: string): boolean;
}

// Narrow write view over TelegramApprovalProvider's own pending-approval
// state -- deliberately a separate interface from IApprovalPendingReader
// above, not folded into it: reading whether something is pending and
// actively rejecting it are different capabilities with different blast
// radii, so a consumer that only needs one never gains type-level access to
// the other. Backed by the exact same `settle()` TelegramApprovalProvider
// already uses for the Telegram approve/reject button and its own timeout --
// this is a third caller of that one method, not a new mechanism.
export interface IApprovalCanceller {
  // Returns false when nothing is pending for this correlationId (already
  // decided, timed out, or never existed) -- true only when it actually
  // settled a still-pending request.
  reject(correlationId: string, reason?: string): boolean;
}
