import type { ExecutionResult } from "../controller/types";
import type { IResponseFormatter } from "./interfaces";

export class ResponseFormatter implements IResponseFormatter {
  format(result: ExecutionResult): string {
    const { taskResult } = result;

    if (!taskResult.success) {
      return `Task "${taskResult.taskType}" failed: ${taskResult.error ?? "unknown error"}`;
    }

    return taskResult.output
      ? `Task "${taskResult.taskType}" completed successfully.\n\n${taskResult.output}`
      : `Task "${taskResult.taskType}" completed successfully.`;
  }
}
