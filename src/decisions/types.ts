export type InsightSeverity = "info" | "warning" | "critical";

interface InsightBase {
  severity: InsightSeverity;
  repositoryId: string;
  notificationWorthy: boolean;
}

export type Insight =
  | (InsightBase & { kind: "unclean-working-tree"; staged: number; unstaged: number; untracked: number })
  | (InsightBase & { kind: "unpushed-commits"; ahead: number })
  | (InsightBase & { kind: "stale-branch"; branch: string; behind: number; lastCommitAt?: Date })
  | (InsightBase & { kind: "unfinished-workflow"; workflowId: string; correlationId: string; failedStepId?: string })
  // Repository Failure Policy redesign: `occurrences` has a dual meaning
  // depending on which field is set. When `taskType` is set, it's the
  // *consecutive* failure count for that task type (sourced from
  // ProjectMemoryService's persisted per-repository/task-type counter --
  // one success resets it to 0). When `workflowId` is set instead, it's
  // still the *cumulative* count over recent history (unchanged, event-scan
  // based) -- see DecisionEngine.detectRepeatedFailureInsights's own doc
  // comment for why the workflow path was deliberately left as-is.
  | (InsightBase & { kind: "repeated-failures"; taskType?: string; workflowId?: string; occurrences: number })
  | (InsightBase & { kind: "approval-required"; action: "push-changes" | "create-pull-request" })
  | (InsightBase & { kind: "open-pull-requests"; count: number })
  | (InsightBase & { kind: "session-expired"; sessionId: string; lastUsedAt: Date })
  | (InsightBase & { kind: "risky-situation"; contributingKinds: Insight["kind"][] });

export interface RepositoryInsightReport {
  repositoryId: string;
  generatedAt: Date;
  insights: Insight[];
  notificationWorthyInsights: Insight[];
}
