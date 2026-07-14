export class UnknownWorkflowIdError extends Error {
  constructor(workflowId: string) {
    super(`No workflow is registered for id "${workflowId}".`);
    this.name = "UnknownWorkflowIdError";
  }
}
