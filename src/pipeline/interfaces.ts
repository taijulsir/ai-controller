import type { PipelineRequest, PipelineResult } from "./types";

export interface IExecutionPipeline {
  run(request: PipelineRequest): Promise<PipelineResult>;
}
