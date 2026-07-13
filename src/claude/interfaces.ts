import type { ClaudeExecutionResult, ClaudeRunState } from "./types";

export interface ClaudeExecuteOptions {
  continue?: boolean;
}

export interface IClaudeAdapter {
  execute(prompt: string, options?: ClaudeExecuteOptions): Promise<ClaudeExecutionResult>;
  stream(prompt: string, options?: ClaudeExecuteOptions): AsyncIterable<string>;
  stopSession(): Promise<void>;
  getStatus(): ClaudeRunState;
  isRunning(): boolean;
}
