import type { JournalOperationType } from "../journal/types";

export interface ConflictMarkerRange {
  startLine: number;
  endLine: number;
}

export interface ConflictedFile {
  path: string;
  isBinary: boolean;
  // undefined for binary files -- never attempt a textual diff on one
  markers: ConflictMarkerRange[] | undefined;
}

export interface ConflictReport {
  // always Merge or Rebase
  operation: JournalOperationType;
  files: ConflictedFile[];
  autoResolvableCount: number;
}

export enum ConflictResolutionMode {
  Auto = "auto",
  Guided = "guided",
  Abort = "abort",
}

export type ConflictResolutionOutcome =
  | { kind: "resolved"; filesResolved: string[] }
  | { kind: "aborted" }
  | { kind: "needs-guidance"; unresolvedFiles: string[] };

// "declined" is a deviation from the Phase 0 freeze, noted in the
// implementation report: it became necessary once the "ask" divergence
// strategy was actually implemented -- the frozen type had no way to
// express "the operator was asked and said no," only the three outcomes
// that never involve a decision point.
export type SyncOutcome =
  | { kind: "up-to-date" }
  | { kind: "fast-forwarded"; toRef: string }
  | { kind: "delegated"; to: "rebase" | "merge"; outcome: RebaseOutcome | MergeOutcome }
  | { kind: "declined" };

export type RebaseOutcome =
  | { kind: "completed"; rewrittenCommits: number }
  | { kind: "conflict"; conflict: ConflictReport }
  | { kind: "no-op" };

export type MergeOutcome =
  | { kind: "already-up-to-date" }
  | { kind: "fast-forwarded" }
  | { kind: "merged"; commitSha: string }
  | { kind: "conflict"; conflict: ConflictReport };
