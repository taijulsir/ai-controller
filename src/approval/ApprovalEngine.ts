import { randomUUID } from "node:crypto";
import type { IConfigService } from "../config/interfaces";
import type { IControllerCore } from "../controller/interfaces";
import { isTaskExecutionResult } from "../controller/types";
import type { ExecutionRequest, ExecutionResult } from "../controller/types";
import { ApprovalPolicy } from "./ApprovalPolicy";
import type { IApprovalPolicy, IApprovalProvider } from "./interfaces";
import type { ApprovalDecision } from "./types";

export class ApprovalEngine implements IControllerCore {
  constructor(
    private readonly innerControllerCore: IControllerCore,
    private readonly configService: IConfigService,
    private readonly approvalProvider: IApprovalProvider,
    private readonly approvalPolicy: IApprovalPolicy = new ApprovalPolicy(),
  ) {}

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const correlationId = request.correlationId ?? randomUUID();
    const normalizedRequest: ExecutionRequest = { ...request, correlationId };

    if (normalizedRequest.kind === "workflow") {
      // A workflow request is never gated as a whole: WorkflowOrchestrator
      // re-enters through this same ApprovalEngine instance once per step
      // (each step is its own task-kind ExecutionRequest), so approval is
      // still enforced per mutating step — never bypassed, never duplicated
      // here.
      return this.innerControllerCore.execute(normalizedRequest);
    }

    const controllerConfig = this.configService.getControllerConfig();
    if (!this.approvalPolicy.requiresApproval(normalizedRequest.task, controllerConfig)) {
      const result = await this.innerControllerCore.execute(normalizedRequest);
      return this.attachApproval(result, { required: false });
    }

    const decision = await this.approvalProvider.requestApproval({
      task: normalizedRequest.task,
      repositoryId: normalizedRequest.repositoryId,
      correlationId,
    });

    if (!decision.approved) {
      return this.buildRejectedResult(normalizedRequest, decision, correlationId);
    }

    const result = await this.innerControllerCore.execute(normalizedRequest);
    return this.attachApproval(result, { required: true, approvedBy: decision.approvedBy, approvedAt: new Date() });
  }

  private attachApproval(
    result: ExecutionResult,
    approval: Extract<ExecutionResult, { kind: "task" }>["approval"],
  ): ExecutionResult {
    if (!isTaskExecutionResult(result)) {
      return result;
    }
    return { ...result, approval };
  }

  private buildRejectedResult(
    request: Extract<ExecutionRequest, { kind: "task" }>,
    decision: Extract<ApprovalDecision, { approved: false }>,
    correlationId: string,
  ): ExecutionResult {
    const now = new Date();
    return {
      kind: "task",
      taskResult: {
        taskType: request.task.type,
        success: false,
        error: decision.reason ?? "Request was not approved.",
        repositoryId: request.repositoryId,
        correlationId,
      },
      startedAt: now,
      completedAt: now,
      durationMs: 0,
      approval: { required: true, approvedAt: now },
    };
  }
}
