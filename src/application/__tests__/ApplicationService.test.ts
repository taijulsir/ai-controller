import { describe, expect, it } from "vitest";
import type { Repository } from "../../domain/repository/Repository";
import type { GitHistoryFilter, GitHistoryResult } from "../../git/types";
import type { IGitHistoryService } from "../../git/interfaces";
import { JournalOperationType } from "../../journal/types";
import type { IRepositoryRegistry } from "../../repositories/interfaces";
import type { ISafeUndoFramework, IUndoService } from "../../undo/interfaces";
import type { GitUndoPlan, UndoPlan } from "../../undo/types";
import { ApplicationService } from "../ApplicationService";

// ApplicationService's constructor is the composition root's own full
// dependency list (~30 collaborators) -- every slot this test never
// exercises is filled with `undefined as never` rather than a real fake,
// since undoLastExecution() (the one method under test here) never touches
// them; a bug that made it touch one would fail loudly with a native
// TypeError, not silently.
function buildApplicationService(deps: {
  repositoryRegistry: IRepositoryRegistry;
  undoService: IUndoService;
  safeUndoFramework: ISafeUndoFramework;
  gitHistoryService: IGitHistoryService;
}): ApplicationService {
  const unused = undefined as never;
  return new ApplicationService(
    unused,
    unused,
    unused,
    unused,
    deps.repositoryRegistry,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    deps.undoService,
    unused,
    unused,
    unused,
    unused,
    deps.safeUndoFramework,
    deps.gitHistoryService,
    unused,
    unused,
  );
}

function fakeRegistry(repositoryId = "repo-1"): IRepositoryRegistry {
  const repository: Repository = { id: repositoryId, name: repositoryId, path: "/tmp/repo", defaultBranch: "main", active: true };
  return {
    getAllRepositories: () => [repository],
    getRepository: () => repository,
    getActiveRepository: () => repository,
    setActiveRepository: () => {},
    repositoryExists: () => true,
    refresh: () => {},
  };
}

function emptyUndoPlan(status: UndoPlan["status"]): UndoPlan {
  return { status, canUndo: false, repositoryId: "repo-1", filesToRestore: [], filesToDelete: [], conflictingFiles: [] };
}

function readyTaskPlan(): UndoPlan {
  return {
    status: "ready",
    canUndo: true,
    repositoryId: "repo-1",
    checkpointId: "checkpoint-1",
    taskType: "implement-feature",
    filesToRestore: ["a.ts"],
    filesToDelete: [],
    conflictingFiles: [],
    beforeSnapshot: "before-tree",
    capturedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function gitPlan(overrides: Partial<GitUndoPlan> = {}): GitUndoPlan {
  return {
    journalEntryId: "entry-1",
    operation: JournalOperationType.Commit,
    strategy: "reset-soft",
    requiresApproval: false,
    recordedAt: new Date("2026-01-02T00:00:00Z"),
    afterRef: "6739c2e44833dbed637f3d9702fb03c378a7f2f2",
    ...overrides,
  };
}

function fakeUndoService(plan: UndoPlan, executed?: { called: boolean }): IUndoService {
  return {
    buildUndoPlan: async () => plan,
    executeUndoPlan: async () => {
      if (executed) executed.called = true;
      return { kind: "undone", checkpointId: plan.checkpointId!, taskType: plan.taskType!, restoredFiles: plan.filesToRestore, deletedFiles: plan.filesToDelete };
    },
  };
}

function fakeSafeUndoFramework(plan: GitUndoPlan | undefined, executed?: { called: boolean }): ISafeUndoFramework {
  return {
    buildUndoPlan: async () => plan,
    executeUndoPlan: async () => {
      if (executed) executed.called = true;
    },
  };
}

function fakeGitHistoryService(historyResult: GitHistoryResult): IGitHistoryService {
  return {
    getHistory: async () => historyResult,
    getCommitDetail: async () => {
      throw new Error("not needed");
    },
    getCommitDiffStat: async () => {
      throw new Error("not needed");
    },
  };
}

function historyResult(commits: GitHistoryResult["commits"] = []): GitHistoryResult {
  return { repositoryId: "repo-1", commits, currentBranch: "main", headSha: "deadbeef", detachedHead: false };
}

// Regression coverage for the Git History & Inspection System's own "/undo"
// redesign: a bare "/undo" must never execute anything, and "/undo <hash>"
// must only execute when <hash> is actually what the winning plan would
// undo -- see UndoOutcome's own doc comments in src/undo/types.ts and
// ApplicationService.undoLastExecution()'s.
describe("ApplicationService.undoLastExecution", () => {
  it("previews recent commits and executes nothing when target is undefined", async () => {
    const commits = [{ sha: "aaa", shortSha: "aaa1234", message: "feat: x", author: "Taijul", date: new Date() }];
    const taskExecuted = { called: false };
    const gitExecuted = { called: false };
    const service = buildApplicationService({
      repositoryRegistry: fakeRegistry(),
      undoService: fakeUndoService(emptyUndoPlan("nothing-to-undo"), taskExecuted),
      safeUndoFramework: fakeSafeUndoFramework(gitPlan(), gitExecuted),
      gitHistoryService: fakeGitHistoryService(historyResult(commits)),
    });

    const outcome = await service.undoLastExecution(undefined, undefined);

    expect(outcome).toEqual({ kind: "preview", commits });
    expect(taskExecuted.called).toBe(false);
    expect(gitExecuted.called).toBe(false);
  });

  it("executes the git candidate when the given hash matches its afterRef prefix", async () => {
    const gitExecuted = { called: false };
    const service = buildApplicationService({
      repositoryRegistry: fakeRegistry(),
      undoService: fakeUndoService(emptyUndoPlan("nothing-to-undo")),
      safeUndoFramework: fakeSafeUndoFramework(gitPlan(), gitExecuted),
      gitHistoryService: fakeGitHistoryService(historyResult()),
    });

    const outcome = await service.undoLastExecution(undefined, "6739c2e");

    expect(outcome).toEqual({ kind: "git-undone", operation: JournalOperationType.Commit });
    expect(gitExecuted.called).toBe(true);
  });

  it("refuses and reports the expected hash when the given hash does not match the git candidate", async () => {
    const gitExecuted = { called: false };
    const service = buildApplicationService({
      repositoryRegistry: fakeRegistry(),
      undoService: fakeUndoService(emptyUndoPlan("nothing-to-undo")),
      safeUndoFramework: fakeSafeUndoFramework(gitPlan(), gitExecuted),
      gitHistoryService: fakeGitHistoryService(historyResult()),
    });

    const outcome = await service.undoLastExecution(undefined, "wronghash");

    expect(outcome).toEqual({
      kind: "target-mismatch-git",
      expectedHash: "6739c2e44833dbed637f3d9702fb03c378a7f2f2",
      operation: JournalOperationType.Commit,
      givenTarget: "wronghash",
    });
    expect(gitExecuted.called).toBe(false);
  });

  // Regression coverage: afterRef is a branch name (not a commit) for
  // switch-back-to-branch/delete-branch -- a hash-shaped target must never
  // be compared against it as if it were a commit (that produced a
  // "commit main" mislabel before this fix).
  it("requires confirm (not a hash match) when the git candidate's rollback strategy has no commit to reference", async () => {
    const gitExecuted = { called: false };
    const service = buildApplicationService({
      repositoryRegistry: fakeRegistry(),
      undoService: fakeUndoService(emptyUndoPlan("nothing-to-undo")),
      safeUndoFramework: fakeSafeUndoFramework(
        gitPlan({ strategy: "switch-back-to-branch", operation: JournalOperationType.SwitchBranch, afterRef: "main" }),
        gitExecuted,
      ),
      gitHistoryService: fakeGitHistoryService(historyResult()),
    });

    const outcome = await service.undoLastExecution(undefined, "6739c2e");

    expect(outcome).toEqual({ kind: "target-requires-confirm-git", operation: JournalOperationType.SwitchBranch });
    expect(gitExecuted.called).toBe(false);
  });

  it("still executes a branch-shaped git candidate when target is 'confirm'", async () => {
    const gitExecuted = { called: false };
    const service = buildApplicationService({
      repositoryRegistry: fakeRegistry(),
      undoService: fakeUndoService(emptyUndoPlan("nothing-to-undo")),
      safeUndoFramework: fakeSafeUndoFramework(
        gitPlan({ strategy: "delete-branch", operation: JournalOperationType.CreateBranch, afterRef: "feature-x" }),
        gitExecuted,
      ),
      gitHistoryService: fakeGitHistoryService(historyResult()),
    });

    const outcome = await service.undoLastExecution(undefined, "confirm");

    expect(outcome).toEqual({ kind: "git-undone", operation: JournalOperationType.CreateBranch });
    expect(gitExecuted.called).toBe(true);
  });

  it("executes the git candidate unconditionally when target is the literal 'confirm'", async () => {
    const gitExecuted = { called: false };
    const service = buildApplicationService({
      repositoryRegistry: fakeRegistry(),
      undoService: fakeUndoService(emptyUndoPlan("nothing-to-undo")),
      safeUndoFramework: fakeSafeUndoFramework(gitPlan(), gitExecuted),
      gitHistoryService: fakeGitHistoryService(historyResult()),
    });

    const outcome = await service.undoLastExecution(undefined, "confirm");

    expect(outcome).toEqual({ kind: "git-undone", operation: JournalOperationType.Commit });
    expect(gitExecuted.called).toBe(true);
  });

  // Post-incident regression: a real production /undo <hash> was silently
  // answered with a task-snapshot message instead of acting on (or
  // rejecting) the named commit, because candidate selection used to run a
  // timestamp race *before* ever looking at the target. An explicit hash is
  // now resolved against the Git journal only, never against the
  // task-snapshot plan -- when no Git operation exists at all to match it,
  // that must be reported plainly, never silently swapped for whatever the
  // task plan happens to be, ready or not.
  it("reports a clear 'no matching Git operation' error -- not the task snapshot -- when an explicit hash has nothing to resolve against", async () => {
    const taskExecuted = { called: false };
    const service = buildApplicationService({
      repositoryRegistry: fakeRegistry(),
      undoService: fakeUndoService(readyTaskPlan(), taskExecuted),
      safeUndoFramework: fakeSafeUndoFramework(undefined),
      gitHistoryService: fakeGitHistoryService(historyResult()),
    });

    const outcome = await service.undoLastExecution(undefined, "6739c2e");

    expect(outcome).toEqual({ kind: "target-not-found-git", givenTarget: "6739c2e" });
    expect(taskExecuted.called).toBe(false);
  });

  // Post-incident regression: the exact scenario reported in production --
  // a Claude task checkpoint captured *after* the commit the user actually
  // wants to undo used to win the timestamp race and swallow the user's
  // explicit hash entirely. The hash must now be authoritative: it resolves
  // straight against the Git candidate and executes it, regardless of how
  // much more recent the task checkpoint is.
  it("lets an explicit hash override a newer task checkpoint and undoes the named Git operation", async () => {
    const taskExecuted = { called: false };
    const gitExecuted = { called: false };
    const newerTaskPlan: UndoPlan = { ...readyTaskPlan(), capturedAt: new Date("2026-01-05T00:00:00Z") };
    const olderGitPlan = gitPlan({ recordedAt: new Date("2026-01-02T00:00:00Z") });
    const service = buildApplicationService({
      repositoryRegistry: fakeRegistry(),
      undoService: fakeUndoService(newerTaskPlan, taskExecuted),
      safeUndoFramework: fakeSafeUndoFramework(olderGitPlan, gitExecuted),
      gitHistoryService: fakeGitHistoryService(historyResult()),
    });

    // Sanity check on the fixture itself: the task checkpoint is genuinely
    // newer than the git operation, so the old timestamp-race logic would
    // have picked the task plan here.
    expect(newerTaskPlan.capturedAt!.getTime()).toBeGreaterThan(olderGitPlan.recordedAt.getTime());

    const outcome = await service.undoLastExecution(undefined, "6739c2e");

    expect(outcome).toEqual({ kind: "git-undone", operation: JournalOperationType.Commit });
    expect(gitExecuted.called).toBe(true);
    expect(taskExecuted.called).toBe(false);
  });

  it("executes the task snapshot when target is 'confirm'", async () => {
    const taskExecuted = { called: false };
    const service = buildApplicationService({
      repositoryRegistry: fakeRegistry(),
      undoService: fakeUndoService(readyTaskPlan(), taskExecuted),
      safeUndoFramework: fakeSafeUndoFramework(undefined),
      gitHistoryService: fakeGitHistoryService(historyResult()),
    });

    const outcome = await service.undoLastExecution(undefined, "confirm");

    expect(outcome.kind).toBe("undone");
    expect(taskExecuted.called).toBe(true);
  });

  it("reports execution-in-progress before ever consulting a target, git or otherwise", async () => {
    const service = buildApplicationService({
      repositoryRegistry: fakeRegistry(),
      undoService: fakeUndoService(emptyUndoPlan("execution-in-progress")),
      safeUndoFramework: fakeSafeUndoFramework(gitPlan()),
      gitHistoryService: fakeGitHistoryService(historyResult()),
    });

    const outcome = await service.undoLastExecution(undefined, "confirm");

    expect(outcome).toEqual({ kind: "execution-in-progress" });
  });
});
