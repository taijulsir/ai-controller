import type { GitStatus, WorkingTreeChange, WorkingTreeChangeStatus } from "./types";

export function parseGitStatus(porcelainOutput: string): GitStatus {
  const lines = porcelainOutput.split("\n").filter((line) => line.length > 0);

  let branch = "HEAD";
  let ahead = 0;
  let behind = 0;
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  const recordEntry = (xy: string, filePath: string): void => {
    const [indexStatus, worktreeStatus] = xy.split("");
    if (indexStatus !== ".") staged.push(filePath);
    if (worktreeStatus !== ".") unstaged.push(filePath);
  };

  for (const line of lines) {
    if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length).trim();
      continue;
    }

    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+) -(\d+)/);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("? ")) {
      untracked.push(line.slice(2));
      continue;
    }

    if (line.startsWith("1 ")) {
      const fields = line.split(" ");
      recordEntry(fields[1], fields.slice(8).join(" "));
      continue;
    }

    if (line.startsWith("u ")) {
      const fields = line.split(" ");
      recordEntry(fields[1], fields.slice(10).join(" "));
      continue;
    }

    if (line.startsWith("2 ")) {
      const [entry] = line.split("\t");
      const fields = entry.split(" ");
      recordEntry(fields[1], fields.slice(9).join(" "));
    }
  }

  return {
    branch,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    isClean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
  };
}

// Working Tree Management (/changes, /showchanges, /discard <index>,
// /discard all): a second, richer parse of the exact same `git status
// --porcelain=v2 --branch` output parseGitStatus() already reads -- additive,
// never a replacement (see WorkingTreeChange's own doc comment in
// src/git/types.ts for why this can't just widen GitStatus/parseGitStatus
// instead). Assigns `index` once, here, in a single fixed pass over the
// porcelain output in the order git itself reports entries -- the only place
// an index is ever assigned; every downstream consumer (WorkingTreeService,
// ResponseFormatter) only ever reads change.index, never recomputes one.
export function parseWorkingTreeChanges(porcelainOutput: string): WorkingTreeChange[] {
  const lines = porcelainOutput.split("\n").filter((line) => line.length > 0);
  const changes: WorkingTreeChange[] = [];
  let nextIndex = 1;

  // X/Y are each one of ".", "M", "A", "D", "T", "R", "C", "U" -- ordinary
  // ("1") entries are never actually R/C (renames/copies are always their
  // own "2" record instead, see the "2 " branch below), but this is written
  // to classify whichever of the two sides actually changed regardless, the
  // same defensive-but-correct spirit GitAdapter.mapDiffStatus already
  // applies to a different (commit-diff) status alphabet.
  const classify = (code: string): WorkingTreeChangeStatus => {
    if (code === "A") return "added";
    if (code === "D") return "deleted";
    return "modified";
  };

  for (const line of lines) {
    if (line.startsWith("#")) {
      continue;
    }

    if (line.startsWith("? ")) {
      changes.push({ index: nextIndex++, path: line.slice(2), status: "untracked", staged: false, unstaged: false });
      continue;
    }

    // Unmerged (conflicted) paths -- shown so /changes never silently omits
    // a file the user can see is different, but never offered for /discard
    // (WorkingTreeService.buildDiscardPlan refuses whenever a merge/rebase
    // is in progress at all, which is the only time an unmerged path can
    // exist -- see that method's own doc comment).
    if (line.startsWith("u ")) {
      const fields = line.split(" ");
      const path = fields.slice(10).join(" ");
      changes.push({ index: nextIndex++, path, status: "modified", staged: true, unstaged: true });
      continue;
    }

    if (line.startsWith("1 ")) {
      const fields = line.split(" ");
      const [indexStatus, worktreeStatus] = fields[1].split("");
      const path = fields.slice(8).join(" ");
      const status = classify(worktreeStatus !== "." ? worktreeStatus : indexStatus);
      changes.push({ index: nextIndex++, path, status, staged: indexStatus !== ".", unstaged: worktreeStatus !== "." });
      continue;
    }

    if (line.startsWith("2 ")) {
      const [entry, origPath] = line.split("\t");
      const fields = entry.split(" ");
      const [indexStatus, worktreeStatus] = fields[1].split("");
      const path = fields.slice(9).join(" ");
      changes.push({
        index: nextIndex++,
        path,
        status: "renamed",
        staged: indexStatus !== ".",
        unstaged: worktreeStatus !== ".",
        renamedFrom: origPath,
      });
    }
  }

  return changes;
}
