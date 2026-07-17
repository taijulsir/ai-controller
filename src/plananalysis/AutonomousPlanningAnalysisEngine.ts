import type { AutonomousPlanCycleSummary } from "../plan/types";
import type { AutonomousPlanItemTransition } from "../planhistory/types";
import type { RecommendationKind } from "../recommendations/types";
import type { IAutonomousPlanningAnalysisEngine } from "./interfaces";
import type { AutonomousPlanAnalysisPattern, AutonomousPlanAnalysisReport, AutonomousPlanItemAnalysis } from "./types";

// Kept as internal constants, matching DecisionEngine/ProactiveMonitor/
// RuntimePolicyEngine's own "kept internal for now" precedent -- no YAML
// configuration exists for these, and none is needed yet.
const CHRONIC_CYCLE_THRESHOLD = 5;
const SUSTAINED_ESCALATION_THRESHOLD = 2;
const FLAP_THRESHOLD = 1;

function itemKey(repositoryId: string, kind: RecommendationKind): string {
  return `${repositoryId}::${kind}`;
}

interface TransitionAtCycle {
  transition: AutonomousPlanItemTransition;
  cycleIndex: number;
}

// Pure transform, same shape as AutonomousPlanningEngine/AutonomousPlanEvolutionEngine/
// AutonomousPlanStateEngine: no constructor dependencies, no I/O, synchronous,
// no internal mutable state. Only ever sees an AutonomousPlanCycleSummary[]
// its caller (AutonomousPlanningService) already fetched exactly once -- it
// never calls AutonomousPlanningService, AutonomousPlanHistoryService, or
// AutonomousPlanStateEngine itself, so it cannot recompute or duplicate what
// those already produced. It has no dependency capable of executing a
// Task/workflow, calling Claude, touching git/GitHub, sending a Telegram
// message, or reaching ControllerCore/ExecutionPipeline/ApprovalEngine/
// BackgroundRuntime.
export class AutonomousPlanningAnalysisEngine implements IAutonomousPlanningAnalysisEngine {
  analyze(cycles: AutonomousPlanCycleSummary[]): AutonomousPlanAnalysisReport {
    const transitionsByKey = this.groupTransitionsByKey(cycles);

    const items: AutonomousPlanItemAnalysis[] = [];
    for (const [, refs] of transitionsByKey) {
      const item = this.analyzeKey(refs);
      if (item.patterns.length > 0) {
        items.push(item);
      }
    }

    return {
      generatedAt: new Date(),
      summary: {
        cyclesAnalyzed: cycles.length,
        chronicCount: items.filter((item) => item.patterns.includes("chronic")).length,
        sustainedEscalationCount: items.filter((item) => item.patterns.includes("sustained-escalation")).length,
        flappingCount: items.filter((item) => item.patterns.includes("flapping")).length,
      },
      items,
    };
  }

  // cycles is newest-first (index 0 = newest), so iterating in array order
  // and pushing means each key's refs array is itself ordered newest-first
  // among the cycles that key actually appears in.
  private groupTransitionsByKey(cycles: AutonomousPlanCycleSummary[]): Map<string, TransitionAtCycle[]> {
    const transitionsByKey = new Map<string, TransitionAtCycle[]>();

    cycles.forEach((cycle, cycleIndex) => {
      for (const transition of cycle.entry.evolution.transitions) {
        const key = itemKey(transition.repositoryId, transition.sourceRecommendationKind);
        const refs = transitionsByKey.get(key) ?? [];
        refs.push({ transition, cycleIndex });
        transitionsByKey.set(key, refs);
      }
    });

    return transitionsByKey;
  }

  private analyzeKey(refs: TransitionAtCycle[]): AutonomousPlanItemAnalysis {
    const newest = refs[0];
    const { repositoryId, sourceRecommendationKind, cycleCount } = newest.transition;

    // Chronic and sustained-escalation only ever apply to a key that is
    // actually present in the newest cycle (cycleIndex 0) and not resolved
    // there -- both are claims about an ongoing streak, not history in
    // general.
    const isCurrentlyPresent = newest.cycleIndex === 0 && newest.transition.changeType !== "resolved";

    const consecutiveEscalations = isCurrentlyPresent ? this.countConsecutiveEscalations(refs) : 0;

    // Flapping is deliberately independent of current presence: a key that
    // repeatedly reappeared as "new" within the window is a stability
    // signal even if it happens to be absent from the newest cycle right
    // now.
    const newOccurrences = refs.filter((ref) => ref.transition.changeType === "new").length;
    const flapCount = Math.max(0, newOccurrences - 1);

    const patterns: AutonomousPlanAnalysisPattern[] = [];
    if (isCurrentlyPresent && cycleCount >= CHRONIC_CYCLE_THRESHOLD) {
      patterns.push("chronic");
    }
    if (consecutiveEscalations >= SUSTAINED_ESCALATION_THRESHOLD) {
      patterns.push("sustained-escalation");
    }
    if (flapCount >= FLAP_THRESHOLD) {
      patterns.push("flapping");
    }

    return { repositoryId, sourceRecommendationKind, patterns, cycleCount, consecutiveEscalations, flapCount };
  }

  // Walks cycle indices 0, 1, 2, ... (newest to oldest) for as long as this
  // key has an "escalating" transition at that exact cycle index, stopping
  // at the first gap or non-escalating cycle.
  private countConsecutiveEscalations(refs: TransitionAtCycle[]): number {
    const byCycleIndex = new Map(refs.map((ref) => [ref.cycleIndex, ref.transition]));
    let count = 0;
    let cycleIndex = 0;
    while (true) {
      const transition = byCycleIndex.get(cycleIndex);
      if (!transition || transition.changeType !== "escalating") {
        break;
      }
      count += 1;
      cycleIndex += 1;
    }
    return count;
  }
}
