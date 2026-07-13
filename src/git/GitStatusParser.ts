import type { GitStatus } from "./types";

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
