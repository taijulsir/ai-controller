import type { ExecutionContext, ExecutionContextRequest } from "./types";

export interface IContextBuilder {
  build(request?: ExecutionContextRequest): Promise<ExecutionContext>;
}
