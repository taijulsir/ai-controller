import type { Task } from "../planner/types";

export interface ApprovalRequest {
  task: Task;
  repositoryId?: string;
  correlationId: string;
}

export type ApprovalDecision =
  | { approved: true; approvedBy?: string }
  | { approved: false; reason?: string };
