import type { ExecutionResult, OrchestrationResult } from "../controller/types";
import type { IResponseFormatter } from "./interfaces";

export class ResponseFormatter implements IResponseFormatter {
  format(result: ExecutionResult): string {
    if (result.kind === "workflow") {
      return this.formatWorkflowResult(result.workflowResult);
    }

    const { taskResult } = result;
    if (!taskResult.success) {
      return `Task "${taskResult.taskType}" failed: ${taskResult.error ?? "unknown error"}`;
    }

    return taskResult.output
      ? `Task "${taskResult.taskType}" completed successfully.\n\n${taskResult.output}`
      : `Task "${taskResult.taskType}" completed successfully.`;
  }

  private formatWorkflowResult(workflowResult: OrchestrationResult): string {
    const stepLines = workflowResult.steps.map((step) => {
      const succeeded = step.executionResult.kind === "task" && step.executionResult.taskResult.success;
      return `${succeeded ? "✓" : "✗"} ${step.stepId} (${step.taskType})`;
    });

    if (workflowResult.status === "failed" && workflowResult.failedStep) {
      const failedExecution = workflowResult.failedStep.executionResult;
      const reason = failedExecution.kind === "task" ? failedExecution.taskResult.error ?? "unknown error" : "unknown error";
      return (
        `Workflow "${workflowResult.workflowId}" failed at step "${workflowResult.failedStep.stepId}": ${reason}\n\n` +
        stepLines.join("\n")
      );
    }

    return `Workflow "${workflowResult.workflowId}" completed successfully.\n\n${stepLines.join("\n")}`;
  }
}
