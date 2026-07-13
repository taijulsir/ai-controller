export type ClaudeRunStatus = "idle" | "running" | "completed" | "stopped" | "error";

export interface ClaudeRunState {
  status: ClaudeRunStatus;
  lastExitCode: number | null;
}

export interface ClaudeExecutionResult {
  output: string;
  exitCode: number | null;
}
