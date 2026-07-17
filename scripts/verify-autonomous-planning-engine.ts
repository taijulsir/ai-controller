import { AutonomousPlanningEngine } from "../src/autonomy/AutonomousPlanningEngine";
import type { RecommendationCategory, RecommendationPriority, RepositoryRecommendationReport, SupportingEvidence } from "../src/recommendations/types";

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

function evidence(): SupportingEvidence[] {
  return [{ source: "repository-fact", fact: { name: "branchBehind", behind: 1 } }];
}

function report(
  repositoryId: string,
  recommendations: { kind: RepositoryRecommendationReport["recommendations"][number]["kind"]; category: RecommendationCategory; priority: RecommendationPriority; reason: string }[],
): RepositoryRecommendationReport {
  return {
    repositoryId,
    generatedAt: new Date(),
    recommendations: recommendations.map((r) => ({ ...r, supportingEvidence: evidence() })),
  };
}

function main(): void {
  const engine = new AutonomousPlanningEngine();

  // No reports -> empty, valid plan; a unique id is still assigned
  {
    const plan = engine.buildPlan([]);
    assert(plan.items.length === 0, "no reports -> empty items, not a synthesized fallback");
    assert(plan.repositoriesConsidered.length === 0, "no reports -> repositoriesConsidered is empty");
    assert(typeof plan.id === "string" && plan.id.length > 0, "plan.id is always assigned, even for an empty plan");
  }

  // A repository with zero recommendations still appears in repositoriesConsidered
  {
    const plan = engine.buildPlan([report("clean-repo", [])]);
    assert(plan.repositoriesConsidered.includes("clean-repo"), "a clean repository is still recorded as considered");
    assert(plan.items.length === 0, "a clean repository contributes zero items");
  }

  // Two distinct plans get two distinct ids
  {
    const planA = engine.buildPlan([]);
    const planB = engine.buildPlan([]);
    assert(planA.id !== planB.id, "each call to buildPlan() produces a distinct plan id");
  }

  // Fields are carried forward from Recommendation, not recomputed; sourceRecommendationKind is the rename
  {
    const plan = engine.buildPlan([
      report("alpha", [{ kind: "PullRequired", category: "blocking", priority: "high", reason: "3 commits behind." }]),
    ]);
    const item = plan.items[0];
    assert(item.repositoryId === "alpha", "item carries the repository it came from");
    assert(item.sourceRecommendationKind === "PullRequired", "sourceRecommendationKind carries Recommendation.kind unchanged");
    assert(item.category === "blocking" && item.priority === "high", "category/priority carried forward unchanged");
    assert(item.reason === "3 commits behind.", "reason carried forward unchanged, not reworded");
    assert(item.supportingEvidence.length === 1 && item.supportingEvidence[0].source === "repository-fact", "supportingEvidence carried forward unchanged");
  }

  // Confidence is deterministic and derived from category alone
  {
    const plan = engine.buildPlan([
      report("alpha", [
        { kind: "PullRequired", category: "blocking", priority: "high", reason: "blocking" },
        { kind: "ReviewPullRequest", category: "advisory", priority: "high", reason: "advisory" },
      ]),
    ]);
    const blocking = plan.items.find((i) => i.sourceRecommendationKind === "PullRequired")!;
    const advisory = plan.items.find((i) => i.sourceRecommendationKind === "ReviewPullRequest")!;
    assert(blocking.confidence === "high", "blocking category -> high confidence");
    assert(advisory.confidence === "medium", "advisory category -> medium confidence");
  }

  // Cross-repository ranking: priority first, then category, then repositoryId
  {
    const plan = engine.buildPlan([
      report("beta", [{ kind: "ReviewChanges", category: "advisory", priority: "medium", reason: "beta medium advisory" }]),
      report("alpha", [{ kind: "RepeatedFailures", category: "blocking", priority: "critical", reason: "alpha critical blocking" }]),
      report("gamma", [{ kind: "PullRequired", category: "blocking", priority: "high", reason: "gamma high blocking" }]),
    ]);
    assert(plan.items[0].repositoryId === "alpha" && plan.items[0].priority === "critical", "critical item ranks first across repositories");
    assert(plan.items[1].repositoryId === "gamma" && plan.items[1].priority === "high", "high item ranks second, ahead of medium");
    assert(plan.items[2].repositoryId === "beta" && plan.items[2].priority === "medium", "medium item ranks last");
  }

  // Same priority, different category -> blocking ranks before advisory
  {
    const plan = engine.buildPlan([
      report("alpha", [{ kind: "ReviewChanges", category: "advisory", priority: "high", reason: "advisory high" }]),
      report("beta", [{ kind: "PullRequired", category: "blocking", priority: "high", reason: "blocking high" }]),
    ]);
    assert(plan.items[0].category === "blocking" && plan.items[0].repositoryId === "beta", "equal priority -> blocking ranks before advisory");
  }

  // Same priority and category -> repositoryId breaks the tie deterministically
  {
    const plan = engine.buildPlan([
      report("zulu", [{ kind: "ReviewChanges", category: "advisory", priority: "medium", reason: "zulu" }]),
      report("alpha", [{ kind: "ReviewChanges", category: "advisory", priority: "medium", reason: "alpha" }]),
    ]);
    assert(plan.items[0].repositoryId === "alpha" && plan.items[1].repositoryId === "zulu", "equal priority and category -> repositoryId breaks the tie alphabetically");
  }

  // Determinism: same inputs -> same ordering
  {
    const reports = [
      report("beta", [{ kind: "ReviewChanges", category: "advisory", priority: "medium", reason: "beta" }]),
      report("alpha", [{ kind: "RepeatedFailures", category: "blocking", priority: "critical", reason: "alpha" }]),
    ];
    const planA = engine.buildPlan(reports);
    const planB = engine.buildPlan(reports);
    const orderA = planA.items.map((i) => i.repositoryId);
    const orderB = planB.items.map((i) => i.repositoryId);
    assert(JSON.stringify(orderA) === JSON.stringify(orderB), "identical inputs produce identical, deterministically-ordered output");
  }
}

main();
