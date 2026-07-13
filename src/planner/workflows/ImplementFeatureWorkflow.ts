import type { IClaudeAdapter } from "../../claude/interfaces";
import { MissingTaskInputError } from "../errors";
import type { ITaskWorkflow } from "../interfaces";
import type { ImplementFeatureTask, Task, WorkflowResult } from "../types";

export class ImplementFeatureWorkflow implements ITaskWorkflow {
  constructor(private readonly claudeAdapter: IClaudeAdapter) {}

  async execute(task: Task, _signal: AbortSignal): Promise<WorkflowResult> {
    const { input } = task as ImplementFeatureTask;
    if (!input?.description) {
      throw new MissingTaskInputError(task.type, "description");
    }

    const prompt = `Implement the following feature: ${input.description}`;
    const result = await this.claudeAdapter.execute(prompt);
    return { success: true, output: result.output };
  }
}
