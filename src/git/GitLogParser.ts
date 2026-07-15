import type { CommitSummary } from "./types";

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
