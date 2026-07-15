import type { Insight, RepositoryInsightReport } from "../decisions/types";
import type { RepositorySnapshot } from "../intelligence/types";
import type { ClaudeSessionInfo } from "../session/types";
import type { IRecommendationEngine } from "./interfaces";
import type { Recommendation, RepositoryRecommendationReport, SupportingEvidence } from "./types";

const PRIORITY_ORDER: Record<Recommendation["priority"], number> = { critical: 0, high: 1, medium: 2, low: 3 };

// Pure synthesis: no constructor dependencies, no I/O, synchronous. It only
// ever combines a RepositorySnapshot, a RepositoryInsightReport, and a
// ClaudeSessionInfo that its caller (ApplicationService) already fetched
// exactly once each — it never calls RepositoryIntelligenceService,
// DecisionEngine, or ClaudeSessionManager itself, so there is no way for it
// to recompute or duplicate what those already produced. It never executes a
// Task/workflow, calls Claude, or touches ApprovalEngine — there is no
// dependency here capable of any of that, by construction.
export class RecommendationEngine implements IRecommendationEngine {
  recommend(
    snapshot: RepositorySnapshot,
    insightReport: RepositoryInsightReport,
    session: ClaudeSessionInfo | undefined,
  ): RepositoryRecommendationReport {
    const recommendations: Recommendation[] = [
      ...this.repeatedFailureRecommendations(insightReport.insights),
      ...this.reviewChangesRecommendation(insightReport.insights),
      ...this.pullRequiredRecommendation(snapshot),
      ...this.reviewPullRequestRecommendation(snapshot, insightReport.insights),
      ...this.shipOrContinueRecommendation(snapshot, session),
    ];

    return {
      repositoryId: snapshot.repository.id,
      generatedAt: new Date(),
      recommendations: this.sortByPriority(recommendations),
    };
  }

  private repeatedFailureRecommendations(insights: Insight[]): Recommendation[] {
    return insights
      .filter((insight): insight is Extract<Insight, { kind: "repeated-failures" }> => insight.kind === "repeated-failures" && insight.severity === "critical")
      .map((insight) => ({
        kind: "RepeatedFailures" as const,
        category: "blocking" as const,
        priority: "critical" as const,
        reason: `${insight.taskType ?? insight.workflowId ?? "recent attempts"} has failed ${insight.occurrences} times; analyze before continuing.`,
        supportingEvidence: [this.insightEvidence(insight)],
      }));
  }

  // A risky situation subsumes a plain unclean-working-tree finding — never
  // emit both for the same underlying condition.
  private reviewChangesRecommendation(insights: Insight[]): Recommendation[] {
    const riskySituation = insights.find((insight) => insight.kind === "risky-situation");
    if (riskySituation) {
      return [
        {
          kind: "ReviewChanges",
          category: "blocking",
          priority: "critical",
          reason: "Multiple compounding issues were detected; review the repository before proceeding.",
          supportingEvidence: [this.insightEvidence(riskySituation)],
        },
      ];
    }

    const uncleanWorkingTree = insights.find((insight) => insight.kind === "unclean-working-tree");
    if (uncleanWorkingTree) {
      return [
        {
          kind: "ReviewChanges",
          category: "advisory",
          priority: "medium",
          reason: "The working tree has uncommitted changes worth reviewing before shipping.",
          supportingEvidence: [this.insightEvidence(uncleanWorkingTree)],
        },
      ];
    }

    return [];
  }

  private pullRequiredRecommendation(snapshot: RepositorySnapshot): Recommendation[] {
    if (snapshot.branch.behind <= 0) {
      return [];
    }
    return [
      {
        kind: "PullRequired",
        category: "blocking",
        priority: "high",
        reason: `The current branch is ${snapshot.branch.behind} commit(s) behind its remote counterpart.`,
        supportingEvidence: [
          { source: "repository-fact", fact: { name: "branchBehind", behind: snapshot.branch.behind } },
        ],
      },
    ];
  }

  private reviewPullRequestRecommendation(snapshot: RepositorySnapshot, insights: Insight[]): Recommendation[] {
    if (snapshot.pullRequests.openCount <= 0) {
      return [];
    }
    const openPullRequestsInsight = insights.find((insight) => insight.kind === "open-pull-requests");
    const evidence: SupportingEvidence[] = [
      { source: "repository-fact", fact: { name: "openPullRequests", count: snapshot.pullRequests.openCount } },
    ];
    if (openPullRequestsInsight) {
      evidence.push(this.insightEvidence(openPullRequestsInsight));
    }
    return [
      {
        kind: "ReviewPullRequest",
        category: "advisory",
        priority: "high",
        reason: `${snapshot.pullRequests.openCount} pull request(s) are already open; review before opening another.`,
        supportingEvidence: evidence,
      },
    ];
  }

  // Exactly one of RepositoryReadyToShip / ContinueSession fires — shipping
  // readiness and session continuation are never contradictory advice to
  // give at once; when the repo is ready to ship, an active session enriches
  // that recommendation's reason rather than producing a second one.
  private shipOrContinueRecommendation(snapshot: RepositorySnapshot, session: ClaudeSessionInfo | undefined): Recommendation[] {
    const sessionActive = session?.status === "active";

    if (snapshot.workflowReadiness.canShip) {
      const evidence: SupportingEvidence[] = [
        { source: "repository-fact", fact: { name: "workflowReadiness", canShip: true } },
      ];
      if (sessionActive) {
        evidence.push({ source: "session-fact", fact: { name: "sessionStatus", status: "active" } });
      }
      return [
        {
          kind: "RepositoryReadyToShip",
          category: "advisory",
          priority: "medium",
          reason: sessionActive
            ? "An active implementation session and unshipped changes suggest the work is ready to ship."
            : "The repository has unshipped changes and no blockers prevent shipping.",
          supportingEvidence: evidence,
        },
      ];
    }

    if (sessionActive) {
      return [
        {
          kind: "ContinueSession",
          category: "advisory",
          priority: "medium",
          reason: "An active Claude session exists for this repository; continue the in-progress work.",
          supportingEvidence: [{ source: "session-fact", fact: { name: "sessionStatus", status: "active" } }],
        },
      ];
    }

    return [];
  }

  private insightEvidence(insight: Insight): SupportingEvidence {
    return { source: "insight", insightKind: insight.kind };
  }

  private sortByPriority(recommendations: Recommendation[]): Recommendation[] {
    return [...recommendations].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  }
}
