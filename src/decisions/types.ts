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
