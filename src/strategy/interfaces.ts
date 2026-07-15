import type { StrategyRequest, TaskExecutionStrategy } from "./types";

export interface IExecutionStrategyEngine {
  recommend(request: StrategyRequest): Promise<TaskExecutionStrategy>;
}
