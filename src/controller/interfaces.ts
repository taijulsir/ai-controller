import type { ExecutionRequest, ExecutionResult, OrchestrationResult, WorkflowExecutionRequest } from "./types";

export interface IControllerCore {
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}

// Owned by controller (not orchestration) so ControllerCore can depend on this
// contract the same way it already depends on ITaskPlanner, without the
// orchestration module ever needing to be imported here. The concrete
// WorkflowOrchestrator (in src/orchestration/) implements this interface,
// exactly like ApprovalEngine implements IControllerCore above.
export interface IWorkflowOrchestrator {
  run(request: WorkflowExecutionRequest): Promise<OrchestrationResult>;
}
