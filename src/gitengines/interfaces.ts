import type { ConflictReport, ConflictResolutionMode, ConflictResolutionOutcome, MergeOutcome, RebaseOutcome, SyncOutcome } from "./types";

export interface IConflictResolutionEngine {
  analyze(repositoryId: string): Promise<ConflictReport>;
  resolve(repositoryId: string, report: ConflictReport, mode: ConflictResolutionMode): Promise<ConflictResolutionOutcome>;
}

export interface IIntelligentSyncEngine {
  sync(repositoryId: string, correlationId: string, signal: AbortSignal): Promise<SyncOutcome>;
}

export interface IRebaseEngine {
  rebase(repositoryId: string, correlationId: string, ontoRef: string, signal: AbortSignal): Promise<RebaseOutcome>;
}

export interface IMergeEngine {
  merge(repositoryId: string, correlationId: string, targetBranch: string, signal: AbortSignal): Promise<MergeOutcome>;
}
