import type { IApplicationService } from "../src/application/interfaces";
import type { RepositoryAssistanceReport } from "../src/assistance/types";
import type { RepositoryInsightReport } from "../src/decisions/types";
import type { RepositorySnapshot } from "../src/intelligence/types";
import type { ProjectMemoryEvent } from "../src/memory/types";
import { ProactiveMonitor } from "../src/monitoring/ProactiveMonitor";
import { RecommendationStateStore } from "../src/monitoring/RecommendationStateStore";
import type { MonitoringPolicy } from "../src/monitoring/types";
import type { Recommendation, RepositoryRecommendationReport } from "../src/recommendations/types";
import type { ClaudeSessionInfo } from "../src/session/types";
import type { EngineeringWorkspace } from "../src/workspace/types";

class FakeApplicationService implements IApplicationService {
  public callCount = 0;
  constructor(private readonly recommendationsFor: () => Recommendation[]) {}

  async getRepositoryStatus(): Promise<RepositorySnapshot> {
    throw new Error("not used");
  }
  async getRepositoryHistory(): Promise<ProjectMemoryEvent[]> {
    throw new Error("not used");
  }
  async getRepositoryInsights(): Promise<RepositoryInsightReport> {
    throw new Error("not used");
  }
  getSessionStatus(): ClaudeSessionInfo | undefined {
    throw new Error("not used");
  }
  async getRecommendations(repositoryId?: string): Promise<RepositoryRecommendationReport> {
    this.callCount += 1;
    return {
      repositoryId: repositoryId ?? "alpha",
      generatedAt: new Date(),
      recommendations: this.recommendationsFor(),
    };
  }
  async getEngineeringAssistance(): Promise<RepositoryAssistanceReport> {
    throw new Error("not used");
  }
  async getEngineeringWorkspace(): Promise<EngineeringWorkspace> {
    throw new Error("not used");
  }
}

function recommendation(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    kind: "PullRequired",
    category: "blocking",
    priority: "high",
    reason: "test",
    supportingEvidence: [],
    ...overrides,
  };
}

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

class Clock {
  private current: Date;
  constructor(start: Date) {
    this.current = start;
  }
  now = (): Date => this.current;
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

const policy: MonitoringPolicy = { sustainedDurationMs: 10_000 };

async function main(): Promise<void> {
  // Urgent recommendation appears -> exactly one new-urgent-recommendation event, no duplicate on the next poll
  {
    const clock = new Clock(new Date());
    const store = new RecommendationStateStore(clock.now);
    const appService = new FakeApplicationService(() => [recommendation({ kind: "PullRequired", category: "blocking", priority: "high" })]);
    const monitor = new ProactiveMonitor(appService, policy, store);

    const first = await monitor.evaluate("alpha");
    assert(first.length === 1 && first[0].trigger === "new-urgent-recommendation", "urgent recommendation on first appearance -> new-urgent-recommendation event");
    assert(first[0].recommendationKind === "PullRequired" && first[0].repositoryId === "alpha", "event carries the correct kind and repositoryId");

    const second = await monitor.evaluate("alpha");
    assert(second.length === 0, "same still-active urgent recommendation on the next poll -> no duplicate event (deduplication)");
  }

  // Advisory/medium recommendation does not trigger urgent path
  {
    const clock = new Clock(new Date());
    const store = new RecommendationStateStore(clock.now);
    const appService = new FakeApplicationService(() => [recommendation({ kind: "RepositoryReadyToShip", category: "advisory", priority: "medium" })]);
    const monitor = new ProactiveMonitor(appService, policy, store);

    const events = await monitor.evaluate("alpha");
    assert(events.length === 0, "advisory/medium recommendation -> no immediate urgent event");
  }

  // Sustained duration crossing -> sustained-recommendation event, exactly once
  {
    const clock = new Clock(new Date());
    const store = new RecommendationStateStore(clock.now);
    const appService = new FakeApplicationService(() => [recommendation({ kind: "RepositoryReadyToShip", category: "advisory", priority: "medium" })]);
    const monitor = new ProactiveMonitor(appService, policy, store);

    await monitor.evaluate("alpha"); // t=0, first seen, not yet sustained
    clock.advance(5_000);
    const stillBelowThreshold = await monitor.evaluate("alpha");
    assert(stillBelowThreshold.length === 0, "below the sustained-duration threshold -> no event yet");

    clock.advance(6_000); // total 11s > 10s threshold
    const crossed = await monitor.evaluate("alpha");
    assert(crossed.length === 1 && crossed[0].trigger === "sustained-recommendation", "crossing the sustained-duration threshold -> sustained-recommendation event");

    const afterward = await monitor.evaluate("alpha");
    assert(afterward.length === 0, "sustained event already delivered -> no duplicate on later polls");
  }

  // A recommendation can deliver both an urgent AND (later) a sustained event for the same streak
  {
    const clock = new Clock(new Date());
    const store = new RecommendationStateStore(clock.now);
    const appService = new FakeApplicationService(() => [recommendation({ kind: "PullRequired", category: "blocking", priority: "high" })]);
    const monitor = new ProactiveMonitor(appService, policy, store);

    const urgent = await monitor.evaluate("alpha");
    assert(urgent.length === 1 && urgent[0].trigger === "new-urgent-recommendation", "urgent+blocking recommendation delivers the urgent event first");

    clock.advance(11_000);
    const sustained = await monitor.evaluate("alpha");
    assert(sustained.length === 1 && sustained[0].trigger === "sustained-recommendation", "the same continuous streak later also delivers a distinct sustained event");
  }

  // Disappearance and reappearance resets the streak -> eligible for a fresh urgent event
  {
    const clock = new Clock(new Date());
    const store = new RecommendationStateStore(clock.now);
    let active = true;
    const appService = new FakeApplicationService(() => (active ? [recommendation({ kind: "PullRequired", category: "blocking", priority: "high" })] : []));
    const monitor = new ProactiveMonitor(appService, policy, store);

    const first = await monitor.evaluate("alpha");
    assert(first.length === 1, "first appearance delivers an urgent event");

    active = false;
    await monitor.evaluate("alpha"); // recommendation disappears, state dropped

    active = true;
    const reappeared = await monitor.evaluate("alpha");
    assert(reappeared.length === 1 && reappeared[0].trigger === "new-urgent-recommendation", "disappearance + reappearance starts a fresh streak, eligible for a new urgent event");
  }

  // Multiple simultaneous recommendations -> independently tracked, independent events
  {
    const clock = new Clock(new Date());
    const store = new RecommendationStateStore(clock.now);
    const appService = new FakeApplicationService(() => [
      recommendation({ kind: "PullRequired", category: "blocking", priority: "high" }),
      recommendation({ kind: "RepeatedFailures", category: "blocking", priority: "critical" }),
      recommendation({ kind: "RepositoryReadyToShip", category: "advisory", priority: "medium" }),
    ]);
    const monitor = new ProactiveMonitor(appService, policy, store);

    const events = await monitor.evaluate("alpha");
    assert(events.length === 2, "two urgent recommendations (blocking/high, blocking/critical) -> two events; the medium/advisory one produces none yet");
    assert(new Set(events.map((e) => e.recommendationKind)).size === 2, "events are for distinct recommendation kinds");
  }

  // ApplicationService.getRecommendations() is called exactly once per evaluate() — read-only, no duplicate analysis
  {
    const store = new RecommendationStateStore();
    const appService = new FakeApplicationService(() => []);
    const monitor = new ProactiveMonitor(appService, policy, store);
    await monitor.evaluate("alpha");
    assert(appService.callCount === 1, "evaluate() calls ApplicationService.getRecommendations() exactly once — no independent re-analysis");
  }

  // Default policy is usable without explicit configuration
  {
    const appService = new FakeApplicationService(() => []);
    const monitor = new ProactiveMonitor(appService);
    const events = await monitor.evaluate("alpha");
    assert(Array.isArray(events), "ProactiveMonitor works with its default policy and default state store, no explicit construction required");
  }

  // Transport neutrality: AttentionEvent has no Telegram/notification-specific fields
  {
    const clock = new Clock(new Date());
    const store = new RecommendationStateStore(clock.now);
    const appService = new FakeApplicationService(() => [recommendation({ kind: "PullRequired", category: "blocking", priority: "high" })]);
    const monitor = new ProactiveMonitor(appService, policy, store);
    const events = await monitor.evaluate("alpha");
    const fields = Object.keys(events[0]).sort();
    assert(
      JSON.stringify(fields) === JSON.stringify(["category", "generatedAt", "priority", "reason", "recommendationKind", "repositoryId", "trigger"]),
      "AttentionEvent carries only transport-neutral fields — no chatId, message text formatting, or delivery-specific concepts",
    );
  }
}

main();
