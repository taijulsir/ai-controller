import type { WorkflowDefinition } from "./types";

export interface IWorkflowRegistry {
  get(workflowId: string, repositoryId?: string): WorkflowDefinition;
}
