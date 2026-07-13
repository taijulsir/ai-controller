import type { IClaudeAdapter } from "../../claude/interfaces";
import { MissingTaskInputError } from "../errors";
import type { ITaskWorkflow } from "../interfaces";
import type { ExplainCodeTask, Task, WorkflowResult } from "../types";

export class ExplainCodeWorkflow implements ITaskWorkflow {
  constructor(private readonly claudeAdapter: IClaudeAdapter) {}

  async execute(task: Task, _signal: AbortSignal): Promise<WorkflowResult> {
    const { input } = task as ExplainCodeTask;
    if (!input?.target) {
      throw new MissingTaskInputError(task.type, "target");
    }

    const prompt = `Explain the following part of the codebase: ${input.target}`;
    const result = await this.claudeAdapter.execute(prompt);
    return { success: true, output: result.output };
  }
}
