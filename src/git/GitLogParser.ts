import type { CommitDiffStat, CommitMetadata, CommitSummary } from "./types";

const FIELD_SEPARATOR = "\x1f";
const RECORD_SEPARATOR = "\x1e";

export function parseGitLog(logOutput: string): CommitSummary[] {
  return logOutput
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha, shortSha, author, date, message] = record.split(FIELD_SEPARATOR);
      return {
        sha,
        shortSha,
        message,
        author,
        date: new Date(date),
      };
    });
}

// Parses `git log -1 --pretty=tformat:<SHOW_COMMIT_FORMAT> <hash>`'s single
// line of output (see GitConstants.ts) -- always exactly one record, no
// RECORD_SEPARATOR involved, unlike parseGitLog above.
export function parseCommitMetadata(output: string): CommitMetadata {
  const [sha, shortSha, authorName, authorEmail, authorDate, parents, subject, body] = output.trim().split(FIELD_SEPARATOR);
  return {
    sha,
    shortSha,
    authorName,
    authorEmail,
    authorDate: new Date(authorDate),
    parents: parents.length > 0 ? parents.split(" ") : [],
    subject,
    body,
  };
}

// Parses `git diff-tree --numstat` output: one "insertions\tdeletions\tpath"
// line per changed file, "-\t-\tpath" for a binary file (git's own numstat
// sentinel -- see GitAdapter.conflictedFilesAreBinary's identical check).
export function parseNumstat(output: string): CommitDiffStat[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [insertions, deletions, ...pathParts] = line.split("\t");
      const binary = insertions === "-" && deletions === "-";
      return {
        path: pathParts.join("\t"),
        insertions: binary ? 0 : Number.parseInt(insertions, 10),
        deletions: binary ? 0 : Number.parseInt(deletions, 10),
        binary,
      };
    });
}
