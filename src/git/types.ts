export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  isClean: boolean;
}

export interface CommitSummary {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: Date;
}

// One path's change between two tree-ish snapshots (see GitAdapter.diffChangedFiles).
// "added" means the path did not exist in the "from" snapshot at all -- restoring it
// means deleting it, not checking it out. --no-renames is always passed when this is
// produced, so a rename is deliberately reported as an independent "deleted" (old
// path) + "added" (new path) pair, never a rename record -- correct and simpler to
// restore than relying on git's own (sometimes ambiguous) rename heuristics.
export interface GitFileChange {
  path: string;
  status: "added" | "modified" | "deleted";
}
