import { shipWorkflow } from "./definitions/shipWorkflow";
import { UnknownWorkflowIdError } from "./errors";
import type { IWorkflowRegistry } from "./interfaces";
import type { WorkflowDefinition } from "./types";

// Repository-specific overrides (e.g. a company with a different branching
// strategy) fit here later by consulting `repositoryId` before falling back
// to the generic entry below — WorkflowOrchestrator never changes for that,
// it only ever calls get(). Today's registry is an in-memory map; migrating
// definitions to config/workflows.yaml later only changes how this map is
// populated, not this class's public shape.
export class WorkflowRegistry implements IWorkflowRegistry {
  private readonly definitions = new Map<string, WorkflowDefinition>([[shipWorkflow.id, shipWorkflow]]);

  get(workflowId: string, _repositoryId?: string): WorkflowDefinition {
    const definition = this.definitions.get(workflowId);
    if (!definition) {
      throw new UnknownWorkflowIdError(workflowId);
    }
    return definition;
  }
}
