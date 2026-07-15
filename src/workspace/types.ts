import type { RepositoryAssistanceReport } from "../assistance/types";
import type { RepositoryInsightReport } from "../decisions/types";
import type { RepositorySnapshot } from "../intelligence/types";
import type { ProjectMemoryEvent } from "../memory/types";
import type { AttentionEvent } from "../monitoring/types";
import type { RepositoryRecommendationReport } from "../recommendations/types";
import type { ClaudeSessionInfo } from "../session/types";

// An immutable point-in-time view of a repository's complete read-side
// state — everything the engineer needs to know right now, composed
// entirely from data already produced by existing read-side services.
// "Immutable" describes the value's meaning: a frozen snapshot of a single
// moment, never updated in place — getting a fresher view means calling
// ApplicationService.getEngineeringWorkspace() again, not mutating this
// object. It is not runtime-enforced (no `readonly`/`Readonly<>`), matching
// every other model in this codebase, none of which enforce immutability at
// the type-system level either.
export interface EngineeringWorkspace {
  repositoryId: string;
  generatedAt: Date;
  repository: RepositorySnapshot;
  insights: RepositoryInsightReport;
  recommendations: RepositoryRecommendationReport;
  assistance: RepositoryAssistanceReport;
  session: ClaudeSessionInfo | undefined;
  recentHistory: ProjectMemoryEvent[];
  // Present only when ApplicationService was constructed with a monitoring
  // service; undefined otherwise. Never independently derived or inferred
  // here — Monitoring alone owns deciding and tracking attention-worthy
  // state transitions, this field only ever carries what it reports.
  attentionEvents: AttentionEvent[] | undefined;
}
