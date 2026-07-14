import type { TaskType } from "../planner/types";

export interface WorkflowStepDefinition {
  id: string;
  task: {
    type: TaskType;
    // Each value is either a literal string or a "{{workflowInput.x}}" /
    // "{{steps.stepId.output}}" placeholder, resolved against the workflow's
    // input and prior steps' outputs at execution time (see TemplateResolver).
    input?: Record<string, string>;
  };
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  steps: WorkflowStepDefinition[];
}
