import { randomUUID } from "node:crypto";
import type { IConfigService } from "../config/interfaces";
import type { IControllerCore } from "../controller/interfaces";
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

    const controllerConfig = this.configService.getControllerConfig();
    if (!this.approvalPolicy.requiresApproval(normalizedRequest.task, controllerConfig)) {
      const result = await this.innerControllerCore.execute(normalizedRequest);
      return { ...result, approval: { required: false } };
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
    return {
      ...result,
      approval: { required: true, approvedBy: decision.approvedBy, approvedAt: new Date() },
    };
  }

  private buildRejectedResult(
    request: ExecutionRequest,
    decision: Extract<ApprovalDecision, { approved: false }>,
    correlationId: string,
  ): ExecutionResult {
    const now = new Date();
    return {
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
