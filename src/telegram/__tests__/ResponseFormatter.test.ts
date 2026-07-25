import { describe, expect, it } from "vitest";
import type { CommitDetail, CommitDiffStatResult, CommitSummary, GitHistoryResult } from "../../git/types";
import { JournalOperationType } from "../../journal/types";
import { ResponseFormatter } from "../ResponseFormatter";

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
