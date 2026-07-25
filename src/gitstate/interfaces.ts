import type { RepositoryHealthReport } from "../git/types";
import type { RepositoryState } from "./types";

export interface IGitStateMachine {
  canTransition(from: RepositoryState, to: RepositoryState): boolean;
  legalNextStates(from: RepositoryState): RepositoryState[];
  // Stricter sibling of canTransition() for a caller (Command Orchestrator)
  // that must fail loudly on an illegal transition rather than silently
  // ignore it -- part of the interface so that caller can depend on the
  // abstraction, matching every other policy dependency in this codebase.
  assertTransition(from: RepositoryState, to: RepositoryState): void;
}

// Pure, synchronous, zero I/O -- takes an already-fetched report (from
// IGitHealthService) and classifies it. Where the Health Service answers
// "what do I observe," this answers "what does that mean."
export interface IRepositoryStateAnalyzer {
  classify(report: RepositoryHealthReport): RepositoryState;
}
