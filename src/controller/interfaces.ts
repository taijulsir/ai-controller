import type { ExecutionRequest, ExecutionResult } from "./types";

export interface IControllerCore {
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}
