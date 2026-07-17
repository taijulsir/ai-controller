import type { AutonomousPlanReadinessLevel } from "../planreadiness/types";
import type { AutonomousPlanSequencingEntry, AutonomousPlanSequencingReport } from "../plansequencing/types";
import type { IAutonomousPlanSchedulingEngine } from "./interfaces";
import type { AutonomousPlanSchedulingCadence, AutonomousPlanSchedulingEntry, AutonomousPlanSchedulingReport } from "./types";

// Kept as an internal constant, matching every other "kept internal for
// now" precedent in this arc (DecisionEngine's thresholds,
// RuntimePolicyEngine's defaults, AutonomousPlanReadinessEngine's score
// weights). Unlike those, this mapping produces only a classification —
// never a number, duration, or interval. A future Runtime Policy/
// Configuration layer, not this domain, owns turning a cadence label into
// any concrete timing.
const CADENCE_BY_LEVEL: Record<AutonomousPlanReadinessLevel, AutonomousPlanSchedulingCadence> = {
  low: "frequent",
  medium: "periodic",
  high: "infrequent",
};

// Pure transform, same shape as every engine in this arc: no constructor
// dependencies, no I/O, synchronous, no internal mutable state. Only ever
// sees an AutonomousPlanSequencingReport its caller (ApplicationService)
// already fetched — it never calls AutonomousPlanSequencingEngine or
// anything upstream of it itself, so it cannot recompute or duplicate what
// that domain already produced, and it never reaches back into Readiness or
// Planning for additional signals. It has no dependency capable of
// executing a Task/workflow, calling Claude, touching git/GitHub, sending a
// Telegram message, or reaching ControllerCore/ExecutionPipeline/
// ApprovalEngine/BackgroundRuntime.
//
// Strictly descriptive and strictly a classification: `cadence` is one of
// exactly three labels, never a number of minutes, an interval, a timer, or
// a runtime policy. Entries are enriched in place, never re-sorted — this
// domain adds a temporal classification on top of Plan Sequencing's
// already-reviewed order, it does not re-derive that order.
export class AutonomousPlanSchedulingEngine implements IAutonomousPlanSchedulingEngine {
  schedule(sequence: AutonomousPlanSequencingReport): AutonomousPlanSchedulingReport {
    const entries = sequence.entries.map((entry) => this.toEntry(entry));

    const cadenceBreakdown = { frequent: 0, periodic: 0, infrequent: 0 };
    for (const entry of entries) {
      cadenceBreakdown[entry.cadence] += 1;
    }

    return {
      generatedAt: new Date(),
      summary: {
        entriesScheduled: entries.length,
        currentness: sequence.summary.currentness,
        cadenceBreakdown,
      },
      entries,
    };
  }

  private toEntry(entry: AutonomousPlanSequencingEntry): AutonomousPlanSchedulingEntry {
    return {
      repositoryId: entry.repositoryId,
      sourceRecommendationKind: entry.sourceRecommendationKind,
      level: entry.level,
      cycleCount: entry.cycleCount,
      cadence: CADENCE_BY_LEVEL[entry.level],
    };
  }
}
