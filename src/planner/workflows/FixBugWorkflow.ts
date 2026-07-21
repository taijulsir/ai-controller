import type { IClaudeAdapter } from "../../claude/interfaces";
import { MissingTaskInputError } from "../errors";
import type { ITaskWorkflow } from "../interfaces";
import type { FixBugTask, Task, WorkflowResult } from "../types";

export class FixBugWorkflow implements ITaskWorkflow {
  constructor(
    private readonly claudeAdapter: IClaudeAdapter,
    private readonly shouldContinueSession: boolean,
  ) {}

  async execute(task: Task, signal: AbortSignal): Promise<WorkflowResult> {
    const { input } = task as FixBugTask;
    if (!input?.description) {
      throw new MissingTaskInputError(task.type, "description");
    }

    const prompt = `Fix the following bug: ${input.description}`;
    const result = await this.claudeAdapter.execute(prompt, { continue: this.shouldContinueSession, signal });
    return { success: true, output: result.output };
  }
}
