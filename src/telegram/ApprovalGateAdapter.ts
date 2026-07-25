import type { IApprovalGate } from "../gitorchestration/interfaces";
import type { ApprovalGateRequest } from "../gitorchestration/types";
import type { IApprovalGateDelivery } from "./interfaces";

// Bridges the telegram-facing IApprovalGateDelivery (implemented by
// TelegramApprovalProvider) to the gitorchestration-facing IApprovalGate --
// keeps src/gitorchestration free of any dependency on src/telegram, the
// same direction every other controller-facing/AI-facing boundary in this
// codebase already runs.
export class ApprovalGateAdapter implements IApprovalGate {
  constructor(private readonly delivery: IApprovalGateDelivery) {}

  requestApproval(request: ApprovalGateRequest): Promise<boolean> {
    return this.delivery.requestGateApproval(request);
  }
}
