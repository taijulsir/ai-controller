import { ClaudeAdapter } from "../claude/ClaudeAdapter";
import type { IClaudeAdapter } from "../claude/interfaces";
import type { IConfigService } from "../config/interfaces";
import { GitAdapter } from "../git/GitAdapter";
import type { IGitAdapter } from "../git/interfaces";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import { UnknownTaskTypeError } from "./errors";
import type { ITaskWorkflow, IWorkflowFactory } from "./interfaces";
import type { Task, TaskExecutionContext } from "./types";
import { AnalyzeRepositoryWorkflow } from "./workflows/AnalyzeRepositoryWorkflow";
import { CreateCommitWorkflow } from "./workflows/CreateCommitWorkflow";
import { ExplainCodeWorkflow } from "./workflows/ExplainCodeWorkflow";
import { FixBugWorkflow } from "./workflows/FixBugWorkflow";
import { ImplementFeatureWorkflow } from "./workflows/ImplementFeatureWorkflow";
import { PushChangesWorkflow } from "./workflows/PushChangesWorkflow";

export class WorkflowFactory implements IWorkflowFactory {
  constructor(
    private readonly configService: IConfigService,
    private readonly repositoryRegistry: IRepositoryRegistry,
  ) {}

  create(task: Task, context: TaskExecutionContext): ITaskWorkflow {
    switch (task.type) {
      case "analyze-repository":
        return new AnalyzeRepositoryWorkflow(this.buildClaudeAdapter(context));
      case "explain-code":
        return new ExplainCodeWorkflow(this.buildClaudeAdapter(context));
      case "implement-feature":
        return new ImplementFeatureWorkflow(this.buildClaudeAdapter(context));
      case "fix-bug":
        return new FixBugWorkflow(this.buildClaudeAdapter(context));
      case "create-commit":
        return new CreateCommitWorkflow(this.buildGitAdapter(context));
      case "push-changes":
        return new PushChangesWorkflow(this.buildGitAdapter(context));
      default: {
        const unexpectedTask = task as Task;
        throw new UnknownTaskTypeError(unexpectedTask.type);
      }
    }
  }

  private buildGitAdapter(context: TaskExecutionContext): IGitAdapter {
    return new GitAdapter(this.repositoryRegistry, context.repositoryId);
  }

  private buildClaudeAdapter(context: TaskExecutionContext): IClaudeAdapter {
    return new ClaudeAdapter(this.configService, this.repositoryRegistry, context.repositoryId);
  }
}
