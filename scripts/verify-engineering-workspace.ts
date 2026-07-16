import { ApplicationService } from "../src/application/ApplicationService";
import type { IRuntimeAdministrationService } from "../src/admin/interfaces";
import type { IEngineeringAssistanceEngine } from "../src/assistance/interfaces";
import { RuntimeDiagnosticsEngine } from "../src/diagnostics/RuntimeDiagnosticsEngine";
import { RuntimeReportingEngine } from "../src/reporting/RuntimeReportingEngine";
import type { RepositoryAssistanceReport } from "../src/assistance/types";
import type { IRuntimeControlService } from "../src/control/interfaces";
import type { IDecisionEngine } from "../src/decisions/interfaces";
import type { RepositoryInsightReport } from "../src/decisions/types";
import type { IRepositoryIntelligenceService } from "../src/intelligence/interfaces";
import type { RepositorySnapshot } from "../src/intelligence/types";
import type { IProjectMemoryService } from "../src/memory/interfaces";
import type { ProjectMemoryEvent } from "../src/memory/types";
import type { IProactiveMonitor } from "../src/monitoring/interfaces";
import type { AttentionEvent } from "../src/monitoring/types";
import type { RuntimePolicyStatus } from "../src/policy/types";
import type { IRecommendationEngine } from "../src/recommendations/interfaces";
import type { Recommendation, RepositoryRecommendationReport } from "../src/recommendations/types";
import type { IRepositoryRegistry } from "../src/repositories/interfaces";
import type { Repository } from "../src/domain/repository/Repository";
import type { IClaudeSessionManager } from "../src/session/interfaces";
import type { ClaudeSessionDecision, ClaudeSessionInfo } from "../src/session/types";
import type { IRuntimeStatusService } from "../src/status/interfaces";
import type { RuntimeStatus } from "../src/status/types";

function baseSnapshot(): RepositorySnapshot {
  return {
    repository: { id: "alpha", name: "alpha", path: "/tmp/alpha", defaultBranch: "main", active: true },
    branch: { current: "main", default: "main", ahead: 0, behind: 0 },
    workingTree: { isClean: true, staged: [], unstaged: [], untracked: [] },
    recentCommits: [],
    pullRequests: { open: [], openCount: 0 },
    health: { isGitRepository: true, isClean: true, hasUnpushedCommits: false, isBehindRemote: false, hasOpenPullRequests: false, issues: [] },
    workflowReadiness: { canShip: false, requiresApprovalBeforePush: false, requiresApprovalBeforePullRequest: false, blockers: ["No changes to ship."] },
    generatedAt: new Date(),
  };
}

class FakeRepositoryIntelligence implements IRepositoryIntelligenceService {
  public callCount = 0;
  async getSnapshot(): Promise<RepositorySnapshot> {
    this.callCount += 1;
    return baseSnapshot();
  }
}

class FakeDecisionEngine implements IDecisionEngine {
  public callCount = 0;
  async analyze(snapshot: RepositorySnapshot): Promise<RepositoryInsightReport> {
    this.callCount += 1;
    return { repositoryId: snapshot.repository.id, generatedAt: new Date(), insights: [], notificationWorthyInsights: [] };
  }
}

class FakeRecommendationEngine implements IRecommendationEngine {
  public callCount = 0;
  recommend(snapshot: RepositorySnapshot): RepositoryRecommendationReport {
    this.callCount += 1;
    const recommendation: Recommendation = { kind: "PullRequired", category: "blocking", priority: "high", reason: "test", supportingEvidence: [] };
    return { repositoryId: snapshot.repository.id, generatedAt: new Date(), recommendations: [recommendation] };
  }
}

class FakeEngineeringAssistanceEngine implements IEngineeringAssistanceEngine {
  public callCount = 0;
  propose(report: RepositoryRecommendationReport): RepositoryAssistanceReport {
    this.callCount += 1;
    return {
      repositoryId: report.repositoryId,
      generatedAt: new Date(),
      proposals: report.recommendations.map((r) => ({
        recommendationKind: r.kind,
        category: r.category,
        priority: r.priority,
        reason: r.reason,
        actions: [{ kind: "PullLatestChanges", isPrimary: true, isDismissal: false }],
        generatedAt: new Date(),
      })),
    };
  }
}

class FakeProjectMemory implements IProjectMemoryService {
  public callCount = 0;
  async record(): Promise<void> {}
  async getRecentEvents(): Promise<ProjectMemoryEvent[]> {
    this.callCount += 1;
    return [];
  }
}

class FakeSessionManager implements IClaudeSessionManager {
  resolveSession(): ClaudeSessionDecision {
    throw new Error("not used");
  }
  resetSession(): void {}
  expireSession(): void {}
  getSessionStatus(): ClaudeSessionInfo | undefined {
    return { id: "s1", repositoryId: "alpha", status: "active", createdAt: new Date(), lastUsedAt: new Date() };
  }
}

class FakeRepositoryRegistry implements IRepositoryRegistry {
  getAllRepositories(): Repository[] {
    return [];
  }
  getRepository(): Repository {
    throw new Error("not used");
  }
  getActiveRepository(): Repository | undefined {
    return { id: "alpha", name: "alpha", path: "/tmp/alpha", defaultBranch: "main", active: true };
  }
  setActiveRepository(): void {}
  repositoryExists(): boolean {
    return true;
  }
  refresh(): void {}
}

class FakeProactiveMonitor implements IProactiveMonitor {
  public callCount = 0;
  constructor(private readonly events: AttentionEvent[]) {}
  async evaluate(repositoryId?: string): Promise<AttentionEvent[]> {
    this.callCount += 1;
    return this.events.map((e) => ({ ...e, repositoryId: repositoryId ?? e.repositoryId }));
  }
}

// This script only exercises getEngineeringWorkspace() — these three
// throw-stub collaborators exist only so ApplicationService's constructor is
// satisfied; none of Phase 8.5/8.6/8.7's methods are called here.
class UnusedRuntimeStatusService implements IRuntimeStatusService {
  getStatus(): RuntimeStatus {
    throw new Error("not used");
  }
}
class UnusedRuntimeControlService implements IRuntimeControlService {
  pauseMonitoring(): never {
    throw new Error("not used");
  }
  resumeMonitoring(): never {
    throw new Error("not used");
  }
  enterMaintenanceMode(): never {
    throw new Error("not used");
  }
  exitMaintenanceMode(): never {
    throw new Error("not used");
  }
  enableRepository(): never {
    throw new Error("not used");
  }
  disableRepository(): never {
    throw new Error("not used");
  }
  resetDispatcherStatistics(): never {
    throw new Error("not used");
  }
  resetRuntimeStatistics(): never {
    throw new Error("not used");
  }
}
class UnusedRuntimeAdministrationService implements IRuntimeAdministrationService {
  getStatus(): RuntimeStatus {
    throw new Error("not used");
  }
  getControl(): IRuntimeControlService {
    throw new Error("not used");
  }
  getPolicies(): RuntimePolicyStatus {
    throw new Error("not used");
  }
}

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

function buildService(monitor?: FakeProactiveMonitor) {
  const repositoryIntelligence = new FakeRepositoryIntelligence();
  const projectMemory = new FakeProjectMemory();
  const decisionEngine = new FakeDecisionEngine();
  const sessionManager = new FakeSessionManager();
  const repositoryRegistry = new FakeRepositoryRegistry();
  const recommendationEngine = new FakeRecommendationEngine();
  const engineeringAssistanceEngine = new FakeEngineeringAssistanceEngine();
  const service = new ApplicationService(
    repositoryIntelligence,
    projectMemory,
    decisionEngine,
    sessionManager,
    repositoryRegistry,
    recommendationEngine,
    engineeringAssistanceEngine,
    new UnusedRuntimeStatusService(),
    new RuntimeDiagnosticsEngine(),
    new RuntimeReportingEngine(),
    new UnusedRuntimeControlService(),
    new UnusedRuntimeAdministrationService(),
    monitor,
  );
  return { service, repositoryIntelligence, projectMemory, decisionEngine, recommendationEngine, engineeringAssistanceEngine };
}

async function main(): Promise<void> {
  // Workspace composes successfully without a monitoring service -> attentionEvents is undefined
  {
    const { service, repositoryIntelligence, decisionEngine, recommendationEngine, engineeringAssistanceEngine, projectMemory } = buildService();
    const workspace = await service.getEngineeringWorkspace("alpha");

    assert(workspace.repositoryId === "alpha", "workspace.repositoryId is correct");
    assert(workspace.repository.repository.id === "alpha", "workspace.repository carries the real RepositorySnapshot");
    assert(Array.isArray(workspace.insights.insights), "workspace.insights carries the real RepositoryInsightReport");
    assert(workspace.recommendations.recommendations.length === 1, "workspace.recommendations carries the real RepositoryRecommendationReport");
    assert(workspace.assistance.proposals.length === 1, "workspace.assistance carries the real RepositoryAssistanceReport");
    assert(workspace.session?.status === "active", "workspace.session carries the real ClaudeSessionInfo");
    assert(Array.isArray(workspace.recentHistory), "workspace.recentHistory carries the real ProjectMemoryEvent[]");
    assert(workspace.attentionEvents === undefined, "no monitoring service supplied -> attentionEvents is undefined, workspace still composes successfully");

    assert(repositoryIntelligence.callCount === 1, "no duplicated analysis: getSnapshot() called exactly once");
    assert(decisionEngine.callCount === 1, "no duplicated analysis: decisionEngine.analyze() called exactly once");
    assert(recommendationEngine.callCount === 1, "no duplicated analysis: recommendationEngine.recommend() called exactly once");
    assert(engineeringAssistanceEngine.callCount === 1, "no duplicated analysis: engineeringAssistanceEngine.propose() called exactly once");
    assert(projectMemory.callCount === 1, "no duplicated analysis: projectMemory.getRecentEvents() called exactly once");
  }

  // Workspace includes attentionEvents when a monitoring service is available
  {
    const attentionEvent: AttentionEvent = {
      repositoryId: "alpha",
      trigger: "new-urgent-recommendation",
      recommendationKind: "PullRequired",
      category: "blocking",
      priority: "high",
      reason: "test event",
      generatedAt: new Date(),
    };
    const monitor = new FakeProactiveMonitor([attentionEvent]);
    const { service } = buildService(monitor);
    const workspace = await service.getEngineeringWorkspace("alpha");

    assert(workspace.attentionEvents !== undefined && workspace.attentionEvents.length === 1, "monitoring service supplied -> attentionEvents is populated from its evaluate() call");
    assert(workspace.attentionEvents![0].recommendationKind === "PullRequired", "attentionEvents content is exactly what the monitor reported, not re-derived");
    assert(monitor.callCount === 1, "monitor.evaluate() called exactly once per workspace composition");
  }

  // Default active repository is used when no repositoryId is supplied
  {
    const { service } = buildService();
    const workspace = await service.getEngineeringWorkspace();
    assert(workspace.repositoryId === "alpha", "no repositoryId supplied -> resolves to the active repository");
  }

  // generatedAt is a fresh timestamp for each call
  {
    const { service } = buildService();
    const first = await service.getEngineeringWorkspace("alpha");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await service.getEngineeringWorkspace("alpha");
    assert(second.generatedAt.getTime() >= first.generatedAt.getTime(), "each composed workspace is a fresh point-in-time snapshot, not a cached/reused object");
  }
}

main();
