import { ControllerEntryPointNotBoundError } from "./errors";
import type { IControllerCore } from "./interfaces";
import type { ExecutionRequest, ExecutionResult } from "./types";

/**
 * DeferredControllerCore is a composition-root wiring helper. It exists to
 * break a runtime dependency cycle between three collaborators and has no
 * other purpose — it contains no business logic of its own.
 *
 * THE CYCLE IT BREAKS
 * --------------------
 *   1. ControllerCore must route workflow-kind requests to WorkflowOrchestrator
 *      (a direct constructor dependency: ControllerCore -> IWorkflowOrchestrator).
 *   2. WorkflowOrchestrator must run each of a workflow's steps through the
 *      *top-of-stack* IControllerCore — not through ControllerCore directly —
 *      so that a step touching push-changes or create-pull-request still
 *      passes through ApprovalEngine exactly like a standalone command would.
 *      Approval must stay owned exclusively by ApprovalEngine; nothing here
 *      is allowed to special-case or duplicate that policy.
 *   3. ApprovalEngine decorates ControllerCore (ApprovalEngine -> ControllerCore).
 *
 * Combine these three and you get a real cycle at construction time:
 * ControllerCore needs WorkflowOrchestrator, WorkflowOrchestrator needs
 * ApprovalEngine (the top of the stack), and ApprovalEngine needs
 * ControllerCore. None of the three can be `new`-ed first without the other
 * two already existing.
 *
 * THE TRADE-OFF THIS CLASS MAKES
 * -------------------------------
 * Rather than restructure the layering (e.g. folding approval-checking logic
 * into WorkflowOrchestrator, or having ControllerCore reach past
 * WorkflowOrchestrator into ApprovalEngine directly), this class defers the
 * *runtime* binding by one step: the composition root constructs an unbound
 * DeferredControllerCore first, hands it to WorkflowOrchestrator as a stand-in
 * IControllerCore, finishes building ControllerCore and ApprovalEngine around
 * it, and only then calls bind() with the real top-of-stack instance. Every
 * step WorkflowOrchestrator runs after that point transparently reaches the
 * real ApprovalEngine.
 *
 * This keeps the compile-time dependency graph acyclic and matches the
 * existing pattern in this codebase (ApprovalEngine implements IControllerCore,
 * a lower layer's own interface) — but it introduces one deliberate runtime
 * indirection with two consequences a reader should know about:
 *   - execute() will throw ControllerEntryPointNotBoundError if it is ever
 *     called before bind() runs. The composition root (src/index.ts) must
 *     call bind() synchronously, before any request can possibly flow in
 *     (i.e. before the Telegram poller — or any future front-end — starts).
 *   - This class is a wiring-only seam, not a general-purpose pattern: it
 *     should have exactly one instance, created and bound once in the
 *     composition root, and must never be exposed to or depended on by any
 *     module other than src/index.ts and WorkflowOrchestrator's constructor
 *     injection site.
 *
 * Do not redesign this in place. If the cycle ever needs to go away for real,
 * that is a deliberate architectural change to how orchestration and approval
 * relate to each other — not a fix to this file.
 */
export class DeferredControllerCore implements IControllerCore {
  private delegate?: IControllerCore;

  bind(delegate: IControllerCore): void {
    this.delegate = delegate;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    if (!this.delegate) {
      throw new ControllerEntryPointNotBoundError();
    }
    return this.delegate.execute(request);
  }
}
