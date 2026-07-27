import { describe, expect, it } from "vitest";
import type {
  CommitDetail,
  CommitDiffStatResult,
  CommitSummary,
  DiscardOutcome,
  DiscardPlan,
  GitHistoryResult,
  WorkingTreeChange,
  WorkingTreeChangeDiff,
  WorkingTreeChangesResult,
} from "../../git/types";
import type { RepositorySnapshot } from "../../intelligence/types";
import { JournalOperationType } from "../../journal/types";
import type { PipelineContext, PipelineResult } from "../../pipeline/types";
import type { TaskExecutionStrategy } from "../../strategy/types";
import { ResponseFormatter } from "../ResponseFormatter";

function repositorySnapshot(overrides: Partial<RepositorySnapshot["branch"]> = {}): RepositorySnapshot {
  return {
    repository: { id: "gcpay-backend", name: "GCPay Backend", path: "/tmp/gcpay-backend", defaultBranch: "production_2026_mall", active: true },
    branch: { current: "production_2026_mall", default: "production_2026_mall", ahead: 0, behind: 0, ...overrides },
    branches: ["production_2026_mall"],
    workingTree: { isClean: true, staged: [], unstaged: [], untracked: [] },
    recentCommits: [],
    pullRequests: { open: [], openCount: 0 },
    health: { isGitRepository: true, isClean: true, hasUnpushedCommits: false, isBehindRemote: false, hasOpenPullRequests: false, issues: [] },
    workflowReadiness: { canShip: true, requiresApprovalBeforePush: false, requiresApprovalBeforePullRequest: false, blockers: [] },
    generatedAt: new Date(),
  };
}

function commit(overrides: Partial<CommitSummary> = {}): CommitSummary {
  return { sha: "6739c2e44833dbed637f3d9702fb03c378a7f2f2", shortSha: "6739c2e", message: "feat: redesign orchestration", author: "Taijul", date: new Date(), ...overrides };
}

// Regression coverage for the Git History & Inspection System's own new
// formatting -- ResponseFormatter had no dedicated test file before this
// feature; scoped to what this feature added/changed.
describe("ResponseFormatter: Git History & Inspection System", () => {
  const formatter = new ResponseFormatter();

  describe("formatGitHistory", () => {
    it("reports no commits found for an empty result", () => {
      const result: GitHistoryResult = { repositoryId: "repo-1", commits: [], currentBranch: "main", headSha: "", detachedHead: false };
      expect(formatter.formatGitHistory(result)).toMatch(/no commits found/i);
    });

    it("renders each commit with an index, short hash, and message", () => {
      const c1 = commit({ shortSha: "6739c2e", message: "feat(git): redesign orchestration" });
      const c2 = commit({ sha: "4a91b7f0", shortSha: "4a91b7f", message: "fix(bot): approval flow" });
      const result: GitHistoryResult = { repositoryId: "repo-1", commits: [c1, c2], currentBranch: "main", headSha: c1.sha, detachedHead: false };

      const text = formatter.formatGitHistory(result);

      expect(text).toContain("1.");
      expect(text).toContain("6739c2e");
      expect(text).toContain("feat(git): redesign orchestration");
      expect(text).toContain("2.");
      expect(text).toContain("4a91b7f");
      expect(text).toContain("fix(bot): approval flow");
    });

    it("marks the branch tip commit and omits the marker for every other commit", () => {
      const tip = commit({ sha: "aaaa" });
      const other = commit({ sha: "bbbb", shortSha: "bbbbbbb" });
      const result: GitHistoryResult = { repositoryId: "repo-1", commits: [tip, other], currentBranch: "main", headSha: "aaaa", detachedHead: false };

      const text = formatter.formatGitHistory(result);
      const tipLineIndex = text.indexOf("1.");
      const otherLineIndex = text.indexOf("2.");

      expect(text.slice(tipLineIndex, otherLineIndex)).toContain("main");
      expect(text.slice(otherLineIndex)).not.toContain("← ");
    });

    it("omits the branch marker entirely when HEAD is detached", () => {
      const tip = commit({ sha: "aaaa" });
      const result: GitHistoryResult = { repositoryId: "repo-1", commits: [tip], currentBranch: "HEAD", headSha: "aaaa", detachedHead: true };
      expect(formatter.formatGitHistory(result)).not.toContain("← ");
    });

    // Regression coverage: every commit stays listed regardless of the
    // inline-keyboard cap (MAX_HISTORY_KEYBOARD_ITEMS) -- only a note about
    // buttons is conditional.
    it("adds no keyboard-limit note when the commit count is within MAX_HISTORY_KEYBOARD_ITEMS", () => {
      const result: GitHistoryResult = {
        repositoryId: "repo-1",
        commits: Array.from({ length: 10 }, (_, i) => commit({ sha: `sha-${i}`, shortSha: `sha${i}` })),
        currentBranch: "main",
        headSha: "sha-0",
        detachedHead: false,
      };
      expect(formatter.formatGitHistory(result)).not.toMatch(/quick-action buttons/i);
    });

    it("notes that quick-action buttons are limited when the commit count exceeds MAX_HISTORY_KEYBOARD_ITEMS, while still listing every commit", () => {
      const commits = Array.from({ length: 20 }, (_, i) => commit({ sha: `sha-${i}`, shortSha: `sha${i}`, message: `commit number ${i}` }));
      const result: GitHistoryResult = { repositoryId: "repo-1", commits, currentBranch: "main", headSha: "sha-0", detachedHead: false };

      const text = formatter.formatGitHistory(result);

      expect(text).toMatch(/quick-action buttons/i);
      for (const c of commits) {
        expect(text).toContain(c.shortSha);
      }
    });
  });

  describe("formatCommitDetail", () => {
    function detail(overrides: Partial<CommitDetail> = {}): CommitDetail {
      return {
        sha: "6739c2e44833dbed637f3d9702fb03c378a7f2f2",
        shortSha: "6739c2e",
        authorName: "Taijul",
        authorEmail: "taijul@example.com",
        authorDate: new Date("2026-07-25T12:00:00Z"),
        parents: ["97761a5"],
        subject: "feat(git): redesign orchestration",
        isHead: false,
        currentBranch: undefined,
        files: [
          { path: "src/git/GitAdapter.ts", status: "modified" },
          { path: "src/git/GitHistoryService.ts", status: "added" },
          { path: "old/file.ts", status: "deleted" },
        ],
        filesChanged: 3,
        insertions: 42,
        deletions: 8,
        ...overrides,
      };
    }

    it("renders hash, author, parents, subject, and every changed file with its status", () => {
      const text = formatter.formatCommitDetail(detail());

      expect(text).toContain("6739c2e44833dbed637f3d9702fb03c378a7f2f2");
      expect(text).toContain("Taijul");
      expect(text).toContain("taijul@example.com");
      expect(text).toContain("97761a5");
      expect(text).toContain("feat(git): redesign orchestration");
      expect(text).toContain("Modified");
      expect(text).toContain("src/git/GitAdapter.ts");
      expect(text).toContain("Added");
      expect(text).toContain("src/git/GitHistoryService.ts");
      expect(text).toContain("Deleted");
      expect(text).toContain("old/file.ts");
      expect(text).toContain("+42");
      expect(text).toContain("-8");
    });

    it("shows 'none (root commit)' when there are no parents", () => {
      expect(formatter.formatCommitDetail(detail({ parents: [] }))).toContain("none (root commit)");
    });

    it("shows the branch only when the commit is the branch tip", () => {
      const headText = formatter.formatCommitDetail(detail({ isHead: true, currentBranch: "main" }));
      expect(headText).toContain("main");
      expect(headText).toContain("HEAD");

      const nonHeadText = formatter.formatCommitDetail(detail({ isHead: false, currentBranch: undefined }));
      expect(nonHeadText).not.toContain("(HEAD)");
    });
  });

  describe("formatCommitDiff", () => {
    function diffResult(overrides: Partial<CommitDiffStatResult> = {}): CommitDiffStatResult {
      return {
        sha: "6739c2e44833dbed637f3d9702fb03c378a7f2f2",
        shortSha: "6739c2e",
        files: [
          { path: "GitAdapter.ts", insertions: 24, deletions: 8, binary: false },
          { path: "ApplicationService.ts", insertions: 61, deletions: 14, binary: false },
        ],
        filesChanged: 2,
        insertions: 85,
        deletions: 22,
        ...overrides,
      };
    }

    it("renders per-file +/- counts and the aggregate summary", () => {
      const text = formatter.formatCommitDiff(diffResult());

      expect(text).toContain("GitAdapter.ts");
      expect(text).toContain("+24");
      expect(text).toContain("-8");
      expect(text).toContain("ApplicationService.ts");
      expect(text).toContain("+61");
      expect(text).toContain("-14");
      expect(text).toContain("2 file(s) changed");
      expect(text).toContain("+85 insertions");
      expect(text).toContain("-22 deletions");
    });

    it("reports no file changes for an empty commit", () => {
      const text = formatter.formatCommitDiff(diffResult({ files: [], filesChanged: 0, insertions: 0, deletions: 0 }));
      expect(text).toMatch(/no file changes/i);
    });

    it("labels a binary file instead of showing +/- counts", () => {
      const text = formatter.formatCommitDiff(diffResult({ files: [{ path: "logo.png", insertions: 0, deletions: 0, binary: true }] }));
      expect(text).toContain("logo.png");
      expect(text).toContain("binary file");
    });
  });

  describe("formatUndoResult: Git History & Inspection System outcomes", () => {
    it("previews recent commits and points the user at /undo <hash>", () => {
      const text = formatter.formatUndoResult({ kind: "preview", commits: [commit()] });
      expect(text).toContain("6739c2e");
      expect(text).toContain("feat: redesign orchestration");
      expect(text).toMatch(/\/undo/);
    });

    it("reports nothing to undo when the preview has no commits", () => {
      expect(formatter.formatUndoResult({ kind: "preview", commits: [] })).toMatch(/nothing to undo/i);
    });

    // Post-incident fix: an explicit hash resolves against the Git journal
    // only -- when nothing matches at all (not even a mismatch, no Git
    // operation exists to compare against), the message must say so plainly
    // rather than mention a task snapshot the user never asked about.
    it("tells the user no Git operation matches an explicit hash when none exists", () => {
      const text = formatter.formatUndoResult({ kind: "target-not-found-git", givenTarget: "2c0f01b5d" });
      expect(text).toContain("2c0f01b5d");
      expect(text).toMatch(/no undoable git operation/i);
    });

    it("tells the user the expected hash on a git target mismatch", () => {
      const text = formatter.formatUndoResult({
        kind: "target-mismatch-git",
        expectedHash: "6739c2e44833dbed637f3d9702fb03c378a7f2f2",
        operation: JournalOperationType.Commit,
        givenTarget: "wronghash",
      });
      expect(text).toContain("6739c2e");
      expect(text).toContain("wronghash");
      expect(text).toContain(JournalOperationType.Commit);
    });

    it("tells the user to use /undo confirm when the candidate has no commit hash", () => {
      const text = formatter.formatUndoResult({ kind: "target-requires-confirm", taskType: "implement-feature" });
      expect(text).toContain("implement-feature");
      expect(text).toMatch(/confirm/);
    });

    // Regression coverage: this outcome carries no ref/branch-name field at
    // all (unlike target-mismatch-git's expectedHash), so there is nothing
    // for the message to mislabel as "(commit <branch name>)" -- it must
    // read as "no commit to reference", never present a value as one.
    it("tells the user to use /undo confirm for a branch-shaped git candidate, without labeling anything as a commit", () => {
      const text = formatter.formatUndoResult({ kind: "target-requires-confirm-git", operation: JournalOperationType.SwitchBranch });
      expect(text).toContain(JournalOperationType.SwitchBranch);
      expect(text).toMatch(/confirm/);
      expect(text).not.toMatch(/\(commit /i);
    });
  });
});

function change(overrides: Partial<WorkingTreeChange> = {}): WorkingTreeChange {
  return { index: 1, path: "src/foo.ts", status: "modified", staged: false, unstaged: true, ...overrides };
}

describe("ResponseFormatter: Working Tree Management", () => {
  const formatter = new ResponseFormatter();

  describe("formatWorkingTreeChanges", () => {
    it("reports a clean working tree message when there are no changes", () => {
      const result: WorkingTreeChangesResult = {
        repositoryId: "repo-1",
        changes: [],
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        isClean: true,
      };
      expect(formatter.formatWorkingTreeChanges(result)).toMatch(/clean working tree/i);
    });

    it("groups every status into its own section, each file numbered by its own index", () => {
      const result: WorkingTreeChangesResult = {
        repositoryId: "repo-1",
        changes: [
          change({ index: 1, path: "src/mod.ts", status: "modified" }),
          change({ index: 2, path: "src/new.ts", status: "added", staged: true, unstaged: false }),
          change({ index: 3, path: "src/gone.ts", status: "deleted" }),
          change({ index: 4, path: "src/renamed-to.ts", status: "renamed", renamedFrom: "src/renamed-from.ts", staged: true }),
          change({ index: 5, path: "src/untracked.ts", status: "untracked", staged: false, unstaged: false }),
        ],
        stagedCount: 2,
        unstagedCount: 2,
        untrackedCount: 1,
        isClean: false,
      };

      const text = formatter.formatWorkingTreeChanges(result);

      expect(text).toContain("Modified:");
      expect(text).toContain("1.");
      expect(text).toContain("src/mod.ts");
      expect(text).toContain("Added:");
      expect(text).toContain("2.");
      expect(text).toContain("src/new.ts");
      expect(text).toContain("Deleted:");
      expect(text).toContain("3.");
      expect(text).toContain("src/gone.ts");
      expect(text).toContain("Renamed:");
      expect(text).toContain("4.");
      expect(text).toContain("src/renamed-from.ts");
      expect(text).toContain("src/renamed-to.ts");
      expect(text).toContain("Untracked:");
      expect(text).toContain("5.");
      expect(text).toContain("src/untracked.ts");
      expect(text).toContain("Staged: 2");
      expect(text).toContain("Unstaged: 2");
      expect(text).toContain("Untracked: 1");
    });

    it("omits a section entirely when it has no entries", () => {
      const result: WorkingTreeChangesResult = {
        repositoryId: "repo-1",
        changes: [change({ status: "untracked", staged: false, unstaged: false })],
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 1,
        isClean: false,
      };
      const text = formatter.formatWorkingTreeChanges(result);
      expect(text).not.toContain("Modified:");
      expect(text).not.toContain("Added:");
      expect(text).toContain("Untracked:");
    });
  });

  describe("formatWorkingTreeChangeDiff", () => {
    it("renders the file, status, and diff content", () => {
      const result: WorkingTreeChangeDiff = { change: change(), diff: "@@ -1 +1 @@\n-old\n+new" };
      const text = formatter.formatWorkingTreeChangeDiff(result);
      expect(text).toContain("src/foo.ts");
      expect(text).toContain("Modified");
      expect(text).toContain("-old");
      expect(text).toContain("+new");
    });

    it("reports no textual diff for an empty diff", () => {
      const result: WorkingTreeChangeDiff = { change: change(), diff: "" };
      expect(formatter.formatWorkingTreeChangeDiff(result)).toMatch(/no textual diff/i);
    });

    it("truncates a large diff and notes how many more lines exist", () => {
      const bigDiff = Array.from({ length: 250 }, (_, i) => `+line ${i}`).join("\n");
      const result: WorkingTreeChangeDiff = { change: change(), diff: bigDiff };
      const text = formatter.formatWorkingTreeChangeDiff(result);
      expect(text).toContain("+line 0");
      expect(text).toContain("+line 199");
      expect(text).not.toContain("+line 200");
      expect(text).toMatch(/50 more line/);
    });

    it("shows old and new path for a renamed file", () => {
      const result: WorkingTreeChangeDiff = {
        change: change({ status: "renamed", renamedFrom: "src/old.ts", path: "src/new.ts" }),
        diff: "diff --git a/src/old.ts b/src/new.ts",
      };
      const text = formatter.formatWorkingTreeChangeDiff(result);
      expect(text).toContain("src/old.ts");
      expect(text).toContain("src/new.ts");
    });
  });

  describe("formatDiscardResult", () => {
    it("reports nothing to discard when the tree is already clean", () => {
      const plan: DiscardPlan = { status: "nothing-to-discard", repositoryId: "repo-1", target: { kind: "all" }, changes: [], stagedCount: 0, unstagedCount: 0, untrackedCount: 0 };
      expect(formatter.formatDiscardResult(plan)).toMatch(/nothing to discard/i);
    });

    it("refuses while a task is running", () => {
      const plan: DiscardPlan = { status: "execution-in-progress", repositoryId: "repo-1", target: { kind: "all" }, changes: [], stagedCount: 0, unstagedCount: 0, untrackedCount: 0 };
      expect(formatter.formatDiscardResult(plan)).toMatch(/task is currently running/i);
    });

    it("refuses while a git operation is in progress", () => {
      const plan: DiscardPlan = { status: "operation-in-progress", repositoryId: "repo-1", target: { kind: "all" }, changes: [], stagedCount: 0, unstagedCount: 0, untrackedCount: 0 };
      expect(formatter.formatDiscardResult(plan)).toMatch(/merge, rebase, or other git operation/i);
    });

    it("shows a single-file confirmation prompt naming the exact file and the exact reply command", () => {
      const plan: DiscardPlan = {
        status: "ready",
        repositoryId: "repo-1",
        target: { kind: "index", index: 3 },
        changes: [change({ index: 3, path: "src/foo.ts" })],
        stagedCount: 0,
        unstagedCount: 1,
        untrackedCount: 0,
      };
      const text = formatter.formatDiscardResult(plan);
      expect(text).toContain("src/foo.ts");
      expect(text).toContain("/discard 3 confirm");
    });

    it("shows an all-files confirmation prompt listing every affected file and the exact reply command", () => {
      const plan: DiscardPlan = {
        status: "ready",
        repositoryId: "repo-1",
        target: { kind: "all" },
        changes: [change({ index: 1, path: "src/a.ts" }), change({ index: 2, path: "src/b.ts" })],
        stagedCount: 0,
        unstagedCount: 2,
        untrackedCount: 0,
      };
      const text = formatter.formatDiscardResult(plan);
      expect(text).toContain("src/a.ts");
      expect(text).toContain("src/b.ts");
      expect(text).toContain("/discard all confirm");
    });

    it("reports the discard outcome after execution", () => {
      const outcome: DiscardOutcome = {
        kind: "discarded",
        affectedFiles: ["src/foo.ts"],
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        isClean: true,
      };
      const text = formatter.formatDiscardResult(outcome);
      expect(text).toContain("src/foo.ts");
      expect(text).toMatch(/clean/i);
    });

    it("reports remaining counts when the tree isn't fully clean after a partial discard", () => {
      const outcome: DiscardOutcome = {
        kind: "discarded",
        affectedFiles: ["src/foo.ts"],
        stagedCount: 1,
        unstagedCount: 0,
        untrackedCount: 2,
        isClean: false,
      };
      const text = formatter.formatDiscardResult(outcome);
      expect(text).toContain("Staged: 1");
      expect(text).toContain("Untracked: 2");
    });
  });
});

// Failure State Self-Healing: /failures now surfaces Last Failure/Last
// Success timestamps for anything not healthy -- scoped to what this
// feature added.
describe("ResponseFormatter: /failures operational context", () => {
  const formatter = new ResponseFormatter();

  it("shows a compact two-line block for a healthy task type, no timestamps", () => {
    const text = formatter.formatFailureStatus([
      { repositoryId: "repo-1", taskType: "implement-feature" as never, consecutiveFailures: 0, blocked: false, status: "healthy" },
    ]);
    expect(text).toContain("implement-feature");
    expect(text).toContain("Healthy");
    expect(text).not.toContain("Last Failure");
    expect(text).not.toContain("Last Success");
  });

  it("shows Status, Consecutive Failures, Last Failure, and Last Success for a blocked task type", () => {
    const text = formatter.formatFailureStatus([
      {
        repositoryId: "repo-1",
        taskType: "sync" as never,
        consecutiveFailures: 5,
        blocked: true,
        status: "blocked",
        lastFailure: new Date("2026-07-27T17:02:00.000Z"),
        lastSuccess: new Date("2026-07-25T09:18:00.000Z"),
      },
    ]);
    expect(text).toContain("BLOCKED");
    expect(text).toContain("Consecutive Failures: 5");
    expect(text).toContain("Last Failure:");
    expect(text).toContain("2026-07-27 17:02:00 UTC");
    expect(text).toContain("Last Success:");
    expect(text).toContain("2026-07-25 09:18:00 UTC");
  });

  it("omits Last Success when a task type has never succeeded", () => {
    const text = formatter.formatFailureStatus([
      { repositoryId: "repo-1", taskType: "push-changes" as never, consecutiveFailures: 2, blocked: false, status: "warning", lastFailure: new Date("2026-07-27T10:00:00.000Z") },
    ]);
    expect(text).toContain("WARNING");
    expect(text).toContain("Last Failure:");
    expect(text).not.toContain("Last Success");
  });

  it("separates multiple task-type blocks with a dashed rule", () => {
    const text = formatter.formatFailureStatus([
      { repositoryId: "repo-1", taskType: "sync" as never, consecutiveFailures: 5, blocked: true, status: "blocked", lastFailure: new Date() },
      { repositoryId: "repo-1", taskType: "implement-feature" as never, consecutiveFailures: 0, blocked: false, status: "healthy" },
    ]);
    expect(text).toMatch(/-{10,}/);
  });

  it("reports no recorded executions when the list is empty", () => {
    expect(formatter.formatFailureStatus([])).toContain("No task types have recorded any executions yet");
  });
});

// Branch Blocking Observability: scoped to what this feature added -- the
// rich, standalone "blocked" pipeline-step rendering, and /status' new
// Implementation Status label.
describe("ResponseFormatter: Branch Blocking Observability", () => {
  const formatter = new ResponseFormatter();

  function fullPipelineResult(snapshot: RepositorySnapshot, recommendedAction: TaskExecutionStrategy["recommendedAction"]): PipelineResult {
    const context: PipelineContext = { task: { type: "fix-bug", input: { description: "fix cron" } }, repositoryId: snapshot.repository.id, repository: snapshot, generatedAt: new Date("2026-07-27T17:02:00.000Z") };
    const strategy: TaskExecutionStrategy = {
      repositoryId: snapshot.repository.id,
      taskType: "fix-bug",
      sessionPolicy: { action: "start-new", reason: "no-active-session" },
      contextPolicy: { includeRelevantHistory: false, relevantHistoryCount: 0, warnings: [] },
      executionPriority: "blocked",
      approvalExpectation: { expected: false },
      recommendedAction,
      executionReadiness: { ready: false, blockers: [] },
      safetyRecommendations: [],
      generatedAt: context.generatedAt,
    };
    return {
      path: "full",
      context,
      strategy,
      plan: { repositoryId: snapshot.repository.id, task: context.task, strategy, steps: [], generatedAt: context.generatedAt },
      program: { repositoryId: snapshot.repository.id, plan: { repositoryId: snapshot.repository.id, task: context.task, strategy, steps: [], generatedAt: context.generatedAt }, steps: [], generatedAt: context.generatedAt },
      stepOutcomes: [
        {
          status: "blocked",
          capability: "BranchManagement",
          explanation: "Implementation is blocked because the current branch is the repository's protected default branch.",
          recommendedAction: "Switch to an implementation branch and retry.",
        },
      ],
      completed: false,
    };
  }

  it("renders repository, current/default branch, decision, recommendation, and decision time for a blocked step", () => {
    const snapshot = repositorySnapshot({ current: "production_2026_mall", default: "production_2026_mall" });
    const text = formatter.formatPipelineResult(fullPipelineResult(snapshot, "CreateFeatureBranch"));

    expect(text).toContain("GCPay Backend"); // repository display name, matching formatRepositoryStatus' own "Repository" field precedent
    expect(text).toContain("production_2026_mall");
    expect(text).toContain("Implementation is blocked because the current branch is the repository's protected default branch.");
    expect(text).toContain("Switch to an implementation branch and retry.");
    expect(text).toContain("2026-07-27 17:02:00 UTC");
    expect(text).not.toContain("Plan:"); // the generic per-step preamble is replaced entirely for a blocked outcome
  });

  it("distinguishes current from default branch when they differ", () => {
    const snapshot = repositorySnapshot({ current: "mall_international_delivery_2026", default: "production_2026_mall" });
    const text = formatter.formatPipelineResult(fullPipelineResult(snapshot, "ReviewRepository"));

    expect(text).toContain("mall_international_delivery_2026");
    expect(text).toContain("production_2026_mall");
  });

  it("/status shows 'Safe for implementation' when current branch differs from default", () => {
    const text = formatter.formatRepositoryStatus(repositorySnapshot({ current: "mall_international_delivery_2026", default: "production_2026_mall" }));
    expect(text).toContain("Safe for implementation");
    expect(text).not.toContain("Protected branch");
  });

  it("/status shows 'Protected branch' when current branch equals default", () => {
    const text = formatter.formatRepositoryStatus(repositorySnapshot({ current: "production_2026_mall", default: "production_2026_mall" }));
    expect(text).toContain("Protected branch");
    expect(text).not.toContain("Safe for implementation");
  });
});
