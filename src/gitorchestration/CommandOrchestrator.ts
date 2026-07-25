import type { IGitHealthService } from "../git/interfaces";
import type { IGitStateMachine, IRepositoryStateAnalyzer } from "../gitstate/interfaces";
import { RepositoryState } from "../gitstate/types";
import type { IRecoveryPlanner } from "../recovery/interfaces";
import type { IApprovalGate, IAutomaticSafetyPolicies, ICommandOrchestrator, IPreflightValidationPolicy } from "./interfaces";
import { OperationClassification } from "./types";
import type { OrchestratedOperationRequest, OrchestratedOperationResult } from "./types";

// The single entry point every /sync /merge /push /commit /branch /rebase
// /discard command routes through: health check -> classify -> recovery
// short-circuit -> pre-flight validation -> approval gate -> run(). Mirrors
// the existing ApprovalEngine's "gate, then delegate" shape, but for
// git-native operations rather than Claude-editing tasks, and with an extra
// recovery short-circuit ApprovalEngine has no equivalent of.
export class CommandOrchestrator implements ICommandOrchestrator {
  constructor(
    private readonly healthService: IGitHealthService,
    private readonly safetyPolicies: IAutomaticSafetyPolicies,
    private readonly preflightPolicy: IPreflightValidationPolicy,
    private readonly recoveryPlanner: IRecoveryPlanner,
    private readonly approvalGate: IApprovalGate,
    private readonly stateAnalyzer: IRepositoryStateAnalyzer,
    private readonly stateMachine: IGitStateMachine,
  ) {}

  async execute<T>(request: OrchestratedOperationRequest<T>): Promise<OrchestratedOperationResult<T>> {
    const report = await this.healthService.getHealth(request.repositoryId);

    const classification = this.safetyPolicies.classify(request.operation, report);
    if (classification === OperationClassification.RecommendRecovery) {
      const plan = this.recoveryPlanner.plan(report);
      if (plan) {
        // Fail loudly (Git State Machine, §3.18) rather than silently hand
        // back a plan for a transition the frozen table says should never
        // happen -- e.g. a future Unrecoverable classification, which has no
        // legal path back to Recovering. Already-Recovering is not itself a
        // transition (we're not moving state, just re-affirming the plan for
        // the state already detected), so it's exempt from the check.
        const currentState = this.stateAnalyzer.classify(report);
        if (currentState !== RepositoryState.Recovering) {
          this.stateMachine.assertTransition(currentState, RepositoryState.Recovering);
        }
        return { kind: "recommend-recovery", plan };
      }
      // report flagged an in-progress/interrupted operation but the planner
      // classified the resulting state as Clean/Dirty/Diverged (state moved
      // between the two calls) -- fall through to pre-flight, whose own
      // in-progress-operation check produces an ordinary "blocked" verdict
      // instead of this method having to fabricate one.
    }

    const verdict = this.preflightPolicy.validate(request.operation, report, request.input);
    if (verdict.kind === "fail") {
      return { kind: "blocked", verdict };
    }

    if (classification === OperationClassification.RequestApproval) {
      const approved = await this.approvalGate.requestApproval({
        correlationId: request.correlationId,
        summary: `${request.operation} on "${report.repositoryId}"`,
        detail: `Branch "${report.branch}". This operation is configured to require approval before it runs.`,
      });
      if (!approved) {
        return { kind: "awaiting-approval", correlationId: request.correlationId };
      }
    }

    try {
      const value = await request.run();
      return { kind: "executed", value };
    } catch (error) {
      return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }
}
