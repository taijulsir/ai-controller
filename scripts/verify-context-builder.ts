import { ContextBuilder } from "../src/context/ContextBuilder";
import type { ExecutionRequest } from "../src/controller/types";
import type { RepositorySnapshot } from "../src/intelligence/types";
import type { IProjectMemoryService } from "../src/memory/interfaces";
import type { ProjectMemoryEvent, ProjectMemoryOutcome } from "../src/memory/types";
import type { Task } from "../src/planner/types";

class FakeProjectMemory implements IProjectMemoryService {
  constructor(public events: ProjectMemoryEvent[] = []) {}
  async record(_request: ExecutionRequest, _outcome: ProjectMemoryOutcome): Promise<void> {}
  async getRecentEvents(): Promise<ProjectMemoryEvent[]> {
    return this.events;
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

function memoryEvent(taskType: Task["type"], success: boolean): ProjectMemoryEvent {
  return {
    id: Math.random().toString(36),
    recordedAt: new Date(),
    repositoryId: "alpha",
    outcome: {
      kind: "result",
      result: {
        kind: "task",
        taskResult: { success, taskType, correlationId: "c1" },
        startedAt: new Date(),
        completedAt: new Date(),
        durationMs: 1,
      },
    },
  };
}

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

async function main(): Promise<void> {
  // build() takes the RepositorySnapshot directly — no IRepositoryIntelligenceService dependency at all
  {
    const snapshot = baseSnapshot();
    const builder = new ContextBuilder(new FakeProjectMemory([]));
    const context = await builder.build({ repository: snapshot });
    assert(context.repository === snapshot, "the exact same RepositorySnapshot instance is echoed back, no re-fetch");
  }

  // Relevant history filtering still works, sourced independently from Project Memory
  {
    const events = [memoryEvent("implement-feature", false), memoryEvent("push-changes", true), memoryEvent("implement-feature", true)];
    const builder = new ContextBuilder(new FakeProjectMemory(events));
    const context = await builder.build({ repository: baseSnapshot(), task: { type: "implement-feature", input: { description: "x" } } });
    assert(context.recentHistory.length === 3, "recentHistory returns all events from Project Memory");
    assert(context.relevantHistory.length === 2, "relevantHistory filters to the requested task's type");
  }

  // Memory failure surfaces as a warning, doesn't throw
  {
    class FailingMemory implements IProjectMemoryService {
      async record(): Promise<void> {}
      async getRecentEvents(): Promise<ProjectMemoryEvent[]> {
        throw new Error("disk unavailable");
      }
    }
    const builder = new ContextBuilder(new FailingMemory());
    const context = await builder.build({ repository: baseSnapshot() });
    assert(context.warnings.some((w) => w.includes("disk unavailable")), "memory read failure becomes a warning, not a thrown error");
  }
}

main();
