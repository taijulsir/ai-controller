import type { AutonomousPlanItemReadiness, AutonomousPlanReadinessLevel, AutonomousPlanReadinessReport } from "../planreadiness/types";
import type { IAutonomousPlanSequencingEngine } from "./interfaces";
import type { AutonomousPlanSequencingEntry, AutonomousPlanSequencingReport } from "./types";

// Lower number sorts first — "low" readiness surfaces first in the
// descriptive order, the same "most attention-worthy first" bias
// RecommendationEngine and AutonomousPlanningEngine already apply. This is
// the ONLY signal used to rank by readiness — AutonomousPlanItemReadiness.score
// is never read anywhere in this module, matching Phase 9.6's own guidance
// that `level`, not `score`, is the stable contract future consumers should
// depend on.
const LEVEL_ORDER: Record<AutonomousPlanReadinessLevel, number> = { low: 0, medium: 1, high: 2 };

// Pure transform, same shape as every engine in this arc: no constructor
// dependencies, no I/O, synchronous, no internal mutable state. Only ever
// sees an AutonomousPlanReadinessReport its caller (ApplicationService)
// already fetched — it never calls AutonomousPlanReadinessService/Engine
// itself, so it cannot recompute or duplicate what that domain already
// produced. It has no dependency capable of executing a Task/workflow,
// calling Claude, touching git/GitHub, sending a Telegram message, or
// reaching ControllerCore/ExecutionPipeline/ApprovalEngine/BackgroundRuntime.
//
// Strictly descriptive: the output is a relative ordering fact, not a
// commitment about time, cadence, or whether/when anything happens. No
// timing, interval, scheduling, approval, eligibility, or execution concept
// appears anywhere in this module, by design.
export class AutonomousPlanSequencingEngine implements IAutonomousPlanSequencingEngine {
  sequence(readiness: AutonomousPlanReadinessReport): AutonomousPlanSequencingReport {
    const entries = readiness.items
      .map((item) => this.toEntry(item))
      .sort((a, b) => this.compare(a, b));

    return {
      generatedAt: new Date(),
      summary: {
        entriesSequenced: entries.length,
        currentness: readiness.summary.currentness,
        levelBreakdown: { ...readiness.summary.levelBreakdown },
      },
      entries,
    };
  }

  private toEntry(item: AutonomousPlanItemReadiness): AutonomousPlanSequencingEntry {
    return {
      repositoryId: item.repositoryId,
      sourceRecommendationKind: item.sourceRecommendationKind,
      level: item.level,
      cycleCount: item.cycleCount,
    };
  }

  // The documented comparator, applied in exactly this order:
  //   1. readiness level (low before medium before high)
  //   2. cycle count, descending (a longer-observed concern at the same
  //      level sorts earlier)
  //   3. repositoryId, alphabetically
  //   4. sourceRecommendationKind, alphabetically
  // Deterministic: two entries can only ever be considered equal here if
  // every one of these four keys matches exactly.
  private compare(a: AutonomousPlanSequencingEntry, b: AutonomousPlanSequencingEntry): number {
    const levelDelta = LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level];
    if (levelDelta !== 0) {
      return levelDelta;
    }
    const cycleCountDelta = b.cycleCount - a.cycleCount;
    if (cycleCountDelta !== 0) {
      return cycleCountDelta;
    }
    const repositoryDelta = a.repositoryId.localeCompare(b.repositoryId);
    if (repositoryDelta !== 0) {
      return repositoryDelta;
    }
    return a.sourceRecommendationKind.localeCompare(b.sourceRecommendationKind);
  }
}
