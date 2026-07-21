import type { IClaudeAdapter } from "../../claude/interfaces";
import type { ITaskWorkflow } from "../interfaces";
import type { ReviewCodeTask, Task, WorkflowResult } from "../types";

export class ReviewCodeWorkflow implements ITaskWorkflow {
  constructor(
    private readonly claudeAdapter: IClaudeAdapter,
    private readonly shouldContinueSession: boolean,
  ) {}

  async execute(task: Task, signal: AbortSignal): Promise<WorkflowResult> {
    const { input } = task as ReviewCodeTask;
    const scope = input?.focus ? ` with a focus on: ${input.focus}` : "";
    const prompt =
      `Perform a concise, Telegram-friendly AI code review of this repository's current state${scope}. ` +
      "Cover possible bugs, code smells, security concerns, maintainability issues, and architectural observations. " +
      "Structure the response with exactly these sections, in this order: " +
      '"Overall assessment" (one or two sentences), "Strengths" (a short bullet list), ' +
      '"Issues" (a short bullet list, most important first), and "Recommendations" (a short bullet list of concrete improvements). ' +
      "Keep it concise — if there is a lot to say, summarize and prioritize the most important items rather than listing everything.";

    const result = await this.claudeAdapter.execute(prompt, { continue: this.shouldContinueSession, signal });
    return { success: true, output: result.output };
  }
}
