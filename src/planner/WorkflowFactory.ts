import { ClaudeAdapter } from "../claude/ClaudeAdapter";
import type { IClaudeAdapter } from "../claude/interfaces";
import type { IConfigService } from "../config/interfaces";
import { GitAdapter } from "../git/GitAdapter";
import type { IGitAdapter } from "../git/interfaces";
import { GithubAdapter } from "../github/GithubAdapter";
import type { IGithubAdapter } from "../github/interfaces";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import { UnknownTaskTypeError } from "./errors";
import type { ITaskWorkflow, IWorkflowFactory } from "./interfaces";
import type { Task, TaskExecutionContext } from "./types";
import { AnalyzeRepositoryWorkflow } from "./workflows/AnalyzeRepositoryWorkflow";
import { CreateCommitWorkflow } from "./workflows/CreateCommitWorkflow";
import { CreatePullRequestWorkflow } from "./workflows/CreatePullRequestWorkflow";
import { ExplainCodeWorkflow } from "./workflows/ExplainCodeWorkflow";
import { FixBugWorkflow } from "./workflows/FixBugWorkflow";
import { ImplementFeatureWorkflow } from "./workflows/ImplementFeatureWorkflow";
import { ListPullRequestsWorkflow } from "./workflows/ListPullRequestsWorkflow";
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
      case "create-pull-request":
        return new CreatePullRequestWorkflow(this.buildGitAdapter(context), this.buildGithubAdapter(context));
      case "list-pull-requests":
        return new ListPullRequestsWorkflow(this.buildGithubAdapter(context));
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

  private buildGithubAdapter(context: TaskExecutionContext): IGithubAdapter {
    return new GithubAdapter(this.configService, this.repositoryRegistry, context.repositoryId);
  }
}
