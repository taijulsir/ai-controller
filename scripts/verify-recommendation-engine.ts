import type { Insight, RepositoryInsightReport } from "../src/decisions/types";
import type { RepositorySnapshot } from "../src/intelligence/types";
import { RecommendationEngine } from "../src/recommendations/RecommendationEngine";
import type { RecommendationKind } from "../src/recommendations/types";
import type { ClaudeSessionInfo } from "../src/session/types";

function baseSnapshot(overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
  return {
    repository: { id: "alpha", name: "alpha", path: "/tmp/alpha", defaultBranch: "main", active: true },
    branch: { current: "main", default: "main", ahead: 0, behind: 0 },
    workingTree: { isClean: true, staged: [], unstaged: [], untracked: [] },
    recentCommits: [],
    pullRequests: { open: [], openCount: 0 },
    health: { isGitRepository: true, isClean: true, hasUnpushedCommits: false, isBehindRemote: false, hasOpenPullRequests: false, issues: [] },
    workflowReadiness: { canShip: false, requiresApprovalBeforePush: false, requiresApprovalBeforePullRequest: false, blockers: ["No changes to ship."] },
    generatedAt: new Date(),
    ...overrides,
  };
}

function insightReport(insights: Insight[]): RepositoryInsightReport {
  return { repositoryId: "alpha", generatedAt: new Date(), insights, notificationWorthyInsights: insights.filter((i) => i.notificationWorthy) };
}

function repeatedFailuresInsight(occurrences: number): Insight {
  return { kind: "repeated-failures", severity: "critical", repositoryId: "alpha", notificationWorthy: true, taskType: "implement-feature", occurrences };
}

function riskySituationInsight(): Insight {
  return { kind: "risky-situation", severity: "critical", repositoryId: "alpha", notificationWorthy: true, contributingKinds: ["unclean-working-tree", "stale-branch"] };
}

function uncleanWorkingTreeInsight(): Insight {
  return { kind: "unclean-working-tree", severity: "warning", repositoryId: "alpha", notificationWorthy: true, staged: 1, unstaged: 0, untracked: 0 };
}

function openPullRequestsInsight(count: number): Insight {
  return { kind: "open-pull-requests", severity: "info", repositoryId: "alpha", notificationWorthy: false, count };
}

function activeSession(): ClaudeSessionInfo {
  return { id: "s1", repositoryId: "alpha", status: "active", createdAt: new Date(), lastUsedAt: new Date() };
}

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

function kindsOf(report: { recommendations: { kind: RecommendationKind }[] }): RecommendationKind[] {
  return report.recommendations.map((r) => r.kind);
}

function main(): void {
  const engine = new RecommendationEngine();

  // Empty, idle repo -> empty recommendation list, no NoActionNeeded fallback
  {
    const report = engine.recommend(baseSnapshot(), insightReport([]), undefined);
    assert(report.recommendations.length === 0, "clean, idle repository with no session -> empty list, not a synthesized fallback");
    assert(report.repositoryId === "alpha", "repositoryId matches the snapshot");
  }

  // repeated-failures (critical) -> RepeatedFailures, critical, blocking
  {
    const report = engine.recommend(baseSnapshot(), insightReport([repeatedFailuresInsight(4)]), undefined);
    assert(kindsOf(report).includes("RepeatedFailures"), "repeated-failures insight -> RepeatedFailures recommendation");
    const rec = report.recommendations.find((r) => r.kind === "RepeatedFailures")!;
    assert(rec.category === "blocking" && rec.priority === "critical", "RepeatedFailures is blocking/critical");
    assert(rec.supportingEvidence.length === 1 && rec.supportingEvidence[0].source === "insight" && rec.supportingEvidence[0].insightKind === "repeated-failures", "supportingEvidence traces back to the insight kind, not a free-form message");
    assert(rec.reason.includes("4 times"), "reason explains why, using the insight's occurrence count");
  }

  // risky-situation subsumes a plain unclean-working-tree finding -> exactly one ReviewChanges, critical
  {
    const report = engine.recommend(baseSnapshot(), insightReport([riskySituationInsight(), uncleanWorkingTreeInsight()]), undefined);
    const reviewChanges = report.recommendations.filter((r) => r.kind === "ReviewChanges");
    assert(reviewChanges.length === 1, "risky-situation + unclean-working-tree -> exactly one ReviewChanges, not two");
    assert(reviewChanges[0].priority === "critical" && reviewChanges[0].category === "blocking", "risky-situation escalates ReviewChanges to critical/blocking");
  }

  // unclean-working-tree alone (no risky-situation) -> ReviewChanges, medium, advisory
  {
    const report = engine.recommend(baseSnapshot(), insightReport([uncleanWorkingTreeInsight()]), undefined);
    const reviewChanges = report.recommendations.find((r) => r.kind === "ReviewChanges");
    assert(reviewChanges?.priority === "medium" && reviewChanges.category === "advisory", "unclean-working-tree alone -> medium/advisory ReviewChanges");
  }

  // branch behind -> PullRequired, high, blocking, evidence is a repository-fact (not an Insight)
  {
    const snapshot = baseSnapshot({ branch: { current: "main", default: "main", ahead: 0, behind: 3 } });
    const report = engine.recommend(snapshot, insightReport([]), undefined);
    const rec = report.recommendations.find((r) => r.kind === "PullRequired")!;
    assert(!!rec, "branch.behind > 0 -> PullRequired recommendation, with no corresponding Insight required");
    assert(rec.category === "blocking" && rec.priority === "high", "PullRequired is blocking/high");
    assert(rec.supportingEvidence[0].source === "repository-fact" && rec.supportingEvidence[0].fact.name === "branchBehind", "PullRequired is grounded in a repository-fact, not an insight");
  }

  // open pull requests -> ReviewPullRequest, high, advisory
  {
    const snapshot = baseSnapshot({ pullRequests: { open: [], openCount: 2 } });
    const report = engine.recommend(snapshot, insightReport([openPullRequestsInsight(2)]), undefined);
    const rec = report.recommendations.find((r) => r.kind === "ReviewPullRequest")!;
    assert(!!rec, "open pull requests -> ReviewPullRequest recommendation");
    assert(rec.category === "advisory" && rec.priority === "high", "ReviewPullRequest is advisory/high");
    assert(
      rec.supportingEvidence.some((e) => e.source === "repository-fact") && rec.supportingEvidence.some((e) => e.source === "insight"),
      "ReviewPullRequest cites both a repository-fact and the corresponding insight as evidence",
    );
  }

  // canShip, no session -> RepositoryReadyToShip only
  {
    const snapshot = baseSnapshot({ workflowReadiness: { canShip: true, requiresApprovalBeforePush: false, requiresApprovalBeforePullRequest: false, blockers: [] } });
    const report = engine.recommend(snapshot, insightReport([]), undefined);
    assert(kindsOf(report).includes("RepositoryReadyToShip"), "canShip -> RepositoryReadyToShip");
    assert(!kindsOf(report).includes("ContinueSession"), "no active session -> ContinueSession not also emitted");
  }

  // canShip AND active session -> RepositoryReadyToShip only (not also ContinueSession — no contradictory advice)
  {
    const snapshot = baseSnapshot({ workflowReadiness: { canShip: true, requiresApprovalBeforePush: false, requiresApprovalBeforePullRequest: false, blockers: [] } });
    const report = engine.recommend(snapshot, insightReport([]), activeSession());
    assert(kindsOf(report).filter((k) => k === "RepositoryReadyToShip").length === 1, "canShip + active session -> exactly one RepositoryReadyToShip");
    assert(!kindsOf(report).includes("ContinueSession"), "canShip + active session -> ContinueSession is not also emitted (no contradictory advice)");
    const rec = report.recommendations.find((r) => r.kind === "RepositoryReadyToShip")!;
    assert(rec.reason.toLowerCase().includes("session"), "RepositoryReadyToShip's reason is enriched to mention the active session");
    assert(rec.supportingEvidence.some((e) => e.source === "session-fact"), "RepositoryReadyToShip cites the session-fact as evidence when a session is active");
  }

  // active session, not ready to ship -> ContinueSession only
  {
    const report = engine.recommend(baseSnapshot(), insightReport([]), activeSession());
    assert(kindsOf(report).includes("ContinueSession"), "active session, nothing to ship -> ContinueSession");
    assert(!kindsOf(report).includes("RepositoryReadyToShip"), "not ready to ship -> RepositoryReadyToShip not emitted");
    const rec = report.recommendations.find((r) => r.kind === "ContinueSession")!;
    assert(rec.category === "advisory" && rec.priority === "medium", "ContinueSession is advisory/medium");
  }

  // Priority ordering: critical before high before medium
  {
    const snapshot = baseSnapshot({
      branch: { current: "main", default: "main", ahead: 0, behind: 2 },
      workflowReadiness: { canShip: true, requiresApprovalBeforePush: false, requiresApprovalBeforePullRequest: false, blockers: [] },
    });
    const report = engine.recommend(snapshot, insightReport([repeatedFailuresInsight(4)]), undefined);
    const priorities = report.recommendations.map((r) => r.priority);
    assert(priorities[0] === "critical", "recommendations sorted with critical first");
    assert(priorities.indexOf("high") < priorities.indexOf("medium"), "high sorted before medium");
  }

  // Determinism: same inputs -> same recommendation kinds (order included)
  {
    const snapshot = baseSnapshot({ branch: { current: "main", default: "main", ahead: 0, behind: 1 } });
    const report1 = engine.recommend(snapshot, insightReport([uncleanWorkingTreeInsight()]), activeSession());
    const report2 = engine.recommend(snapshot, insightReport([uncleanWorkingTreeInsight()]), activeSession());
    assert(JSON.stringify(kindsOf(report1)) === JSON.stringify(kindsOf(report2)), "identical inputs produce identical, deterministically-ordered output");
  }
}

main();
