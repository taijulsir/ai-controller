export class ApprovalPendingReaderNotBoundError extends Error {
  constructor() {
    super(
      "DeferredApprovalPendingReader.isPending() was called before bind() wired it to the real approval provider.",
    );
    this.name = "ApprovalPendingReaderNotBoundError";
  }
}

export class ApprovalCancellerNotBoundError extends Error {
  constructor() {
    super("DeferredApprovalCanceller.reject() was called before bind() wired it to the real approval provider.");
    this.name = "ApprovalCancellerNotBoundError";
  }
}
