import type { ClaudeExecutionResult } from "./types";

export interface ClaudeExecuteOptions {
  continue?: boolean;
  // Forwarded from TaskPlanner's own per-run AbortController (via each
  // Claude-bound ITaskWorkflow's own `signal` parameter) -- when aborted,
  // ClaudeAdapter kills the actual spawned process the same way its own
  // execution timeout does, rather than only changing what this call
  // eventually returns.
  signal?: AbortSignal;
}

export interface IClaudeAdapter {
  execute(prompt: string, options?: ClaudeExecuteOptions): Promise<ClaudeExecutionResult>;
  stream(prompt: string, options?: ClaudeExecuteOptions): AsyncIterable<string>;
}
