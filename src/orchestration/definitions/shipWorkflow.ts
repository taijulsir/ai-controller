import type { WorkflowDefinition } from "../types";

// The first built-in workflow. It deliberately does NOT include an
// "implement" step: implementing (via the existing implement-feature /
// fix-bug tasks) stays an independent, repeatable action a developer runs as
// many times as needed before deciding the change is ready. "Ship" only
// covers what happens once that decision is made.
//
// "Approval" does not appear as a step here on purpose: push-changes and
// create-pull-request already pass through ApprovalPolicy every time they're
// executed via ControllerCore, whether standalone or as part of this
// workflow. Adding an explicit approval step would duplicate policy that
// ApprovalEngine already owns exclusively.
export const shipWorkflow: WorkflowDefinition = {
  id: "ship",
  name: "Ship current changes",
  steps: [
    { id: "verify-status", task: { type: "verify-git-status" } },
    {
      id: "commit",
      task: { type: "create-commit", input: { message: "{{workflowInput.message}}" } },
    },
    { id: "push", task: { type: "push-changes" } },
    {
      id: "create-pr",
      task: {
        type: "create-pull-request",
        input: {
          title: "{{workflowInput.message}}",
          body: "{{workflowInput.body}}",
          baseBranch: "{{workflowInput.baseBranch}}",
        },
      },
    },
  ],
};
