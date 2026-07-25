import type { RepositoryHealthReport } from "../git/types";
import type { JournalOperationType } from "../journal/types";
import type {
  ApprovalGateRequest,
  DivergenceStrategy,
  OperationClassification,
  OrchestratedOperationRequest,
  OrchestratedOperationResult,
  PreflightVerdict,
} from "./types";

// Pure, zero I/O -- same shape as the existing ApprovalPolicy/
// UndoableTaskPolicy/TaskCancellationPolicy. Takes an already-fetched
// report; never calls Git Health Service itself.
export interface IPreflightValidationPolicy {
  validate(operation: JournalOperationType, report: RepositoryHealthReport, input?: Record<string, string>): PreflightVerdict;
}

export interface IAutomaticSafetyPolicies {
  classify(operation: JournalOperationType, report: RepositoryHealthReport): OperationClassification;
  divergenceStrategy(repositoryId: string): DivergenceStrategy;
}

export interface ICommandOrchestrator {
  execute<T>(request: OrchestratedOperationRequest<T>): Promise<OrchestratedOperationResult<T>>;
}

// Narrow, new interface -- deliberately not a change to the existing
// ApprovalEngine/IControllerCore contract. The concrete implementation
// adapts TelegramApprovalProvider; it does not duplicate its pending-map/
// timeout logic (see the implementation report for how).
export interface IApprovalGate {
  requestApproval(request: ApprovalGateRequest): Promise<boolean>;
}
