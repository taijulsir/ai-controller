import { ApprovalGateNotBoundError } from "./errors";
import type { IApprovalGate } from "./interfaces";
import type { ApprovalGateRequest } from "./types";

export class DeferredApprovalGate implements IApprovalGate {
  private delegate?: IApprovalGate;

  bind(delegate: IApprovalGate): void {
    this.delegate = delegate;
  }

  requestApproval(request: ApprovalGateRequest): Promise<boolean> {
    if (!this.delegate) {
      throw new ApprovalGateNotBoundError();
    }
    return this.delegate.requestApproval(request);
  }
}
