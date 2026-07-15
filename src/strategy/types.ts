import type { Insight } from "../decisions/types";
import type { RepositorySnapshot } from "../intelligence/types";
import type { Task, TaskType } from "../planner/types";

export type SessionPolicy =
  | { action: "continue"; sessionId: string }
  | { action: "start-new"; reason: "no-active-session" | "session-expired" };

export interface ContextPolicy {
  includeRelevantHistory: boolean;
  relevantHistoryCount: number;
  warnings: string[];
}

export type ExecutionPriority = "normal" | "elevated" | "blocked";

export interface ApprovalExpectation {
  expected: boolean;
  reason?: string;
}

// Engineering intentions, not workflow ids — which named workflow (if any)
// fulfills an intention is a decision for a future planning layer, not this
// engine. Kept as a closed set so callers can exhaustively switch on it.
export type RecommendedAction =
  | "AnalyzeFirst"
  | "ContinueCurrentTask"
  | "CreateFeatureBranch"
  | "ShipChanges"
  | "ReviewRepository"
  | "WaitForApproval";

export interface ExecutionReadiness {
  ready: boolean;
  blockers: string[];
}

export interface SafetyRecommendation {
  severity: Insight["severity"];
  message: string;
  insightKind: Insight["kind"];
}

export interface TaskExecutionStrategy {
  repositoryId: string;
  taskType: TaskType;
  sessionPolicy: SessionPolicy;
  contextPolicy: ContextPolicy;
  executionPriority: ExecutionPriority;
  approvalExpectation: ApprovalExpectation;
  recommendedAction: RecommendedAction;
  executionReadiness: ExecutionReadiness;
  safetyRecommendations: SafetyRecommendation[];
  generatedAt: Date;
}

export interface StrategyRequest {
  task: Task;
  repository: RepositorySnapshot;
}
