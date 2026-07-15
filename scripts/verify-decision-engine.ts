import { DecisionEngine } from "../src/decisions/DecisionEngine";
import type { IProjectMemoryService } from "../src/memory/interfaces";
import type { ExecutionRequest } from "../src/controller/types";
import type { ProjectMemoryEvent, ProjectMemoryOutcome } from "../src/memory/types";
import type { RepositorySnapshot } from "../src/intelligence/types";
import type { IClaudeSessionManager } from "../src/session/interfaces";
import type { ClaudeSessionDecision, ClaudeSessionInfo } from "../src/session/types";

class FakeProjectMemory implements IProjectMemoryService {
  constructor(public events: ProjectMemoryEvent[] = []) {}
  async record(_request: ExecutionRequest, _outcome: ProjectMemoryOutcome): Promise<void> {}
  async getRecentEvents(): Promise<ProjectMemoryEvent[]> {
    return this.events;
  }
}

class FakeSessionManager implements IClaudeSessionManager {
  constructor(public status: ClaudeSessionInfo | undefined = undefined) {}
  resolveSession(): ClaudeSessionDecision {
    throw new Error("not used in this verification");
  }
  resetSession(): void {}
  expireSession(): void {}
  getSessionStatus(): ClaudeSessionInfo | undefined {
    return this.status;
  }
}

function baseSnapshot(overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
  return {
    repository: { id: "alpha", name: "alpha", path: "/tmp/alpha", defaultBranch: "main", active: true },
    branch: { current: "main", default: "main", ahead: 0, behind: 0 },
    workingTree: { isClean: true, staged: [], unstaged: [], untracked: [] },
    recentCommits: [],
    pullRequests: { open: [], openCount: 0 },
    health: { isGitRepository: true, isClean: true, hasUnpushedCommits: false, isBehindRemote: false, hasOpenPullRequests: false, issues: [] },
    workflowReadiness: { canShip: true, requiresApprovalBeforePush: false, requiresApprovalBeforePullRequest: false, blockers: [] },
    generatedAt: new Date(),
    ...overrides,
  };
}

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

async function main(): Promise<void> {
  // analyze() takes the RepositorySnapshot directly — no IRepositoryIntelligenceService dependency at all
  {
    const engine = new DecisionEngine(new FakeProjectMemory([]), new FakeSessionManager(undefined));
    const report = await engine.analyze(baseSnapshot());
    assert(report.repositoryId === "alpha", "repositoryId is derived from the passed-in snapshot");
    assert(report.insights.length === 0, "clean snapshot, no history -> no insights");
  }

  // Unclean working tree in the passed snapshot -> insight detected, no fetch involved
  {
    const engine = new DecisionEngine(new FakeProjectMemory([]), new FakeSessionManager(undefined));
    const snapshot = baseSnapshot({ workingTree: { isClean: false, staged: ["a.ts"], unstaged: [], untracked: [] } });
    const report = await engine.analyze(snapshot);
    assert(
      report.insights.some((i) => i.kind === "unclean-working-tree"),
      "unclean-working-tree insight detected directly from the passed snapshot",
    );
  }

  // Session state still comes from ClaudeSessionManager independently (out of PipelineContext's scope)
  {
    const expiredSession: ClaudeSessionInfo = { id: "s1", repositoryId: "alpha", status: "expired", createdAt: new Date(), lastUsedAt: new Date() };
    const engine = new DecisionEngine(new FakeProjectMemory([]), new FakeSessionManager(expiredSession));
    const report = await engine.analyze(baseSnapshot());
    assert(
      report.insights.some((i) => i.kind === "session-expired"),
      "session-expired insight still derived from ClaudeSessionManager, independent of the snapshot",
    );
  }

  // Two calls with two different snapshot objects for the same repository id produce independently-correct results
  {
    const engine = new DecisionEngine(new FakeProjectMemory([]), new FakeSessionManager(undefined));
    const cleanReport = await engine.analyze(baseSnapshot());
    const dirtyReport = await engine.analyze(baseSnapshot({ workingTree: { isClean: false, staged: [], unstaged: ["b.ts"], untracked: [] } }));
    assert(cleanReport.insights.length === 0, "first call reasons about its own passed-in snapshot");
    assert(dirtyReport.insights.some((i) => i.kind === "unclean-working-tree"), "second call reasons about its own, different, passed-in snapshot");
  }
}

main();
