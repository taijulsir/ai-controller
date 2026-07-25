import { ClaudeAdapter } from "../claude/ClaudeAdapter";
import { NoActiveRepositoryError } from "../claude/errors";
import type { IClaudeAdapter } from "../claude/interfaces";
import type { IConfigService } from "../config/interfaces";
import { GitAdapter } from "../git/GitAdapter";
import type { IGitAdapter } from "../git/interfaces";
import type { IIntelligentSyncEngine, IMergeEngine, IRebaseEngine } from "../gitengines/interfaces";
import { GithubAdapter } from "../github/GithubAdapter";
import type { IGithubAdapter } from "../github/interfaces";
import type { IGitTransactionManager } from "../gittransaction/interfaces";
import type { ICommandOrchestrator } from "../gitorchestration/interfaces";
import type { IOperationJournal } from "../journal/interfaces";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import type { IClaudeSessionManager } from "../session/interfaces";
import { UnknownTaskTypeError } from "./errors";
import type { ITaskWorkflow, IWorkflowFactory } from "./interfaces";
import type { Task, TaskExecutionContext } from "./types";
import { AnalyzeRepositoryWorkflow } from "./workflows/AnalyzeRepositoryWorkflow";
import { CreateCommitWorkflow } from "./workflows/CreateCommitWorkflow";
import { CreatePullRequestWorkflow } from "./workflows/CreatePullRequestWorkflow";
import { DiscardWorkflow } from "./workflows/DiscardWorkflow";
import { ExplainCodeWorkflow } from "./workflows/ExplainCodeWorkflow";
import { FixBugWorkflow } from "./workflows/FixBugWorkflow";
import { GitStatusWorkflow } from "./workflows/GitStatusWorkflow";
import { ImplementFeatureWorkflow } from "./workflows/ImplementFeatureWorkflow";
import { CreateBranchWorkflow } from "./workflows/CreateBranchWorkflow";
import { FetchWorkflow } from "./workflows/FetchWorkflow";
import { ListPullRequestsWorkflow } from "./workflows/ListPullRequestsWorkflow";
import { MergeWorkflow } from "./workflows/MergeWorkflow";
import { PushChangesWorkflow } from "./workflows/PushChangesWorkflow";
import { RebaseWorkflow } from "./workflows/RebaseWorkflow";
import { ReviewCodeWorkflow } from "./workflows/ReviewCodeWorkflow";
import { SwitchBranchWorkflow } from "./workflows/SwitchBranchWorkflow";
import { SyncWorkflow } from "./workflows/SyncWorkflow";

export class WorkflowFactory implements IWorkflowFactory {
  constructor(
    private readonly configService: IConfigService,
    private readonly repositoryRegistry: IRepositoryRegistry,
    private readonly sessionManager: IClaudeSessionManager,
    // Git Orchestration redesign: every git-native workflow below now
    // routes through Command Orchestrator (pre-flight validation + approval
    // + recovery short-circuit) instead of hand-rolling its own checks.
    private readonly commandOrchestrator: ICommandOrchestrator,
    private readonly transactionManager: IGitTransactionManager,
    private readonly journal: IOperationJournal,
    private readonly syncEngine: IIntelligentSyncEngine,
    private readonly rebaseEngine: IRebaseEngine,
    private readonly mergeEngine: IMergeEngine,
  ) {}

  create(task: Task, context: TaskExecutionContext): ITaskWorkflow {
    // Every git-native task type below is only ever dispatched by
    // ControllerCore.execute(), which always resolves a concrete repository
    // and correlationId before calling TaskPlanner.run() -- see
    // ControllerCore.ts: `const context: TaskExecutionContext = {
    // repositoryId: repository.id, correlationId }`. Asserted here, not
    // re-validated, since WorkflowFactory has no independent way to resolve
    // either on its own.
    const repositoryId = () => this.requireRepositoryId(context);
    const correlationId = () => this.requireCorrelationId(context);

    switch (task.type) {
      case "analyze-repository":
        return new AnalyzeRepositoryWorkflow(this.buildClaudeAdapter(context), this.resolveShouldContinue(context));
      case "explain-code":
        return new ExplainCodeWorkflow(this.buildClaudeAdapter(context), this.resolveShouldContinue(context));
      case "implement-feature":
        return new ImplementFeatureWorkflow(this.buildClaudeAdapter(context), this.resolveShouldContinue(context));
      case "fix-bug":
        return new FixBugWorkflow(this.buildClaudeAdapter(context), this.resolveShouldContinue(context));
      case "verify-git-status":
        return new GitStatusWorkflow(this.buildGitAdapter(context));
      case "create-commit":
        return new CreateCommitWorkflow(this.buildGitAdapter(context), this.commandOrchestrator, this.transactionManager, repositoryId(), correlationId());
      case "push-changes":
        return new PushChangesWorkflow(this.buildGitAdapter(context), this.commandOrchestrator, this.journal, repositoryId(), correlationId());
      case "create-pull-request":
        return new CreatePullRequestWorkflow(this.buildGitAdapter(context), this.buildGithubAdapter(context));
      case "list-pull-requests":
        return new ListPullRequestsWorkflow(this.buildGithubAdapter(context));
      case "review-code":
        return new ReviewCodeWorkflow(this.buildClaudeAdapter(context), this.resolveShouldContinue(context));
      case "switch-branch":
        return new SwitchBranchWorkflow(this.buildGitAdapter(context), this.commandOrchestrator, this.journal, repositoryId(), correlationId());
      case "create-branch":
        return new CreateBranchWorkflow(this.buildGitAdapter(context), this.commandOrchestrator, this.journal, repositoryId(), correlationId());
      case "fetch":
        return new FetchWorkflow(this.buildGitAdapter(context), this.commandOrchestrator, repositoryId(), correlationId());
      case "sync":
        return new SyncWorkflow(this.commandOrchestrator, this.syncEngine, repositoryId(), correlationId());
      case "merge":
        return new MergeWorkflow(this.commandOrchestrator, this.mergeEngine, repositoryId(), correlationId());
      case "rebase":
        return new RebaseWorkflow(this.buildGitAdapter(context), this.commandOrchestrator, this.rebaseEngine, repositoryId(), correlationId());
      case "discard":
        return new DiscardWorkflow(this.buildGitAdapter(context), this.commandOrchestrator, this.transactionManager, repositoryId(), correlationId());
      default: {
        const unexpectedTask = task as Task;
        throw new UnknownTaskTypeError(unexpectedTask.type);
      }
    }
  }

  private requireRepositoryId(context: TaskExecutionContext): string {
    const repositoryId = context.repositoryId ?? this.repositoryRegistry.getActiveRepository()?.id;
    if (!repositoryId) {
      throw new NoActiveRepositoryError();
    }
    return repositoryId;
  }

  // correlationId is always set by the time a Task reaches here (ControllerCore
  // and ExecutionPipeline's own bypass path both generate one via
  // randomUUID() before calling TaskPlanner.run()) -- this only guards
  // against a caller that skipped that layer entirely, e.g. a unit test.
  private requireCorrelationId(context: TaskExecutionContext): string {
    if (!context.correlationId) {
      throw new Error("Git-native workflows require a correlationId, which TaskExecutionContext did not carry.");
    }
    return context.correlationId;
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

  // Resolves whether the next Claude execution should continue an existing
  // session or start fresh, via the Session Manager's own policy decision —
  // this factory never decides that itself, only plumbs the result through.
  private resolveShouldContinue(context: TaskExecutionContext): boolean {
    return this.sessionManager.resolveSession(this.requireRepositoryId(context)).shouldContinue;
  }
}
