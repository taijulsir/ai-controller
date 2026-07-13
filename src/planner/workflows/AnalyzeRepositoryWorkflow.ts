import type { IClaudeAdapter } from "../../claude/interfaces";
import type { ITaskWorkflow } from "../interfaces";
import type { AnalyzeRepositoryTask, Task, WorkflowResult } from "../types";

export class AnalyzeRepositoryWorkflow implements ITaskWorkflow {
  constructor(private readonly claudeAdapter: IClaudeAdapter) {}

  async execute(task: Task, _signal: AbortSignal): Promise<WorkflowResult> {
    const { input } = task as AnalyzeRepositoryTask;
    const prompt = input?.focus
      ? `Analyze this repository with a focus on: ${input.focus}`
      : "Analyze this repository and summarize its structure, key modules, and overall architecture.";

    const result = await this.claudeAdapter.execute(prompt);
    return { success: true, output: result.output };
  }
}
