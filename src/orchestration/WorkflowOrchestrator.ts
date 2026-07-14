import type { IControllerCore, IWorkflowOrchestrator } from "../controller/interfaces";
import { isTaskExecutionResult } from "../controller/types";
import type { ExecutionRequest, OrchestrationResult, StepExecutionResult, WorkflowExecutionRequest } from "../controller/types";
import type { Task } from "../planner/types";
import { resolveStepInput } from "./TemplateResolver";
import type { StepOutputs } from "./TemplateResolver";
import type { IWorkflowRegistry } from "./interfaces";
import type { WorkflowStepDefinition } from "./types";

export class WorkflowOrchestrator implements IWorkflowOrchestrator {
  constructor(
    // The top-of-stack IControllerCore (plain ControllerCore, or
    // ApprovalEngine wrapping it) — never this orchestrator's own caller
    // directly, which is what lets every step re-enter approval gating.
    // See DeferredControllerCore for how this reference is bound at the
    // composition root without creating an import cycle.
    private readonly controllerCoreEntryPoint: IControllerCore,
    private readonly workflowRegistry: IWorkflowRegistry,
  ) {}

  async run(request: WorkflowExecutionRequest): Promise<OrchestrationResult> {
    const definition = this.workflowRegistry.get(request.workflowId, request.repositoryId);
    const startedAt = new Date();
    const steps: StepExecutionResult[] = [];
    const stepOutputs: StepOutputs = {};

    for (const stepDefinition of definition.steps) {
      const task = this.buildStepTask(stepDefinition, request.input, stepOutputs);

      const stepRequest: ExecutionRequest = {
        kind: "task",
        task,
        repositoryId: request.repositoryId,
        // Reused verbatim (not derived/suffixed) across every step: the
        // Telegram approval provider parses this id back into a chat/update
        // pair with an exact-match pattern, and only one step is ever
        // in-flight at a time since steps run sequentially.
        correlationId: request.correlationId,
      };

      const executionResult = await this.controllerCoreEntryPoint.execute(stepRequest);
      if (!isTaskExecutionResult(executionResult)) {
        throw new Error(`Workflow step "${stepDefinition.id}" unexpectedly returned a workflow-kind result.`);
      }

      const stepResult: StepExecutionResult = { stepId: stepDefinition.id, taskType: task.type, executionResult };
      steps.push(stepResult);

      if (!executionResult.taskResult.success) {
        return this.buildResult(request, "failed", steps, stepResult, startedAt);
      }

      stepOutputs[stepDefinition.id] = { output: executionResult.taskResult.output };
    }

    return this.buildResult(request, "completed", steps, undefined, startedAt);
  }

  private buildStepTask(
    stepDefinition: WorkflowStepDefinition,
    workflowInput: Record<string, unknown>,
    stepOutputs: StepOutputs,
  ): Task {
    const resolvedInput = resolveStepInput(stepDefinition.task.input, workflowInput, stepOutputs);
    const task =
      resolvedInput && Object.keys(resolvedInput).length > 0
        ? { type: stepDefinition.task.type, input: resolvedInput }
        : { type: stepDefinition.task.type };

    // Bridging data-driven step definitions into the statically-typed Task
    // union is an intentional dynamic boundary, same as WorkflowFactory's own
    // `task as Task` narrowing and every workflow's `task as <SpecificTask>`.
    return task as Task;
  }

  private buildResult(
    request: WorkflowExecutionRequest,
    status: OrchestrationResult["status"],
    steps: StepExecutionResult[],
    failedStep: StepExecutionResult | undefined,
    startedAt: Date,
  ): OrchestrationResult {
    const completedAt = new Date();
    return {
      workflowId: request.workflowId,
      correlationId: request.correlationId,
      status,
      steps,
      failedStep,
      startedAt,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
    };
  }
}
