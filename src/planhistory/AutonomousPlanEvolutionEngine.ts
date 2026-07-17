import { CATEGORY_ORDER, PRIORITY_ORDER } from "../autonomy/AutonomousPlanningEngine";
import type { AutonomousPlan, AutonomousPlanItem } from "../autonomy/types";
import type { RecommendationKind } from "../recommendations/types";
import type { IAutonomousPlanEvolutionEngine } from "./interfaces";
import type {
  AutonomousPlanEvolutionReport,
  AutonomousPlanHistoryEntry,
  AutonomousPlanItemTransition,
  PlanItemChangeType,
} from "./types";

function itemKey(repositoryId: string, kind: RecommendationKind): string {
  return `${repositoryId}::${kind}`;
}

// Pure transform, same shape as AutonomousPlanningEngine: no constructor
// dependencies, no I/O, synchronous, and no internal mutable state of its
// own. Everything it needs to know about prior cycles arrives inside
// `previous` (the last recorded AutonomousPlanHistoryEntry, itself already
// carrying its own evolution) — this engine never reads or writes
// AutonomousPlanHistoryService itself, so calling it twice with the same
// inputs is always safe: nothing here is mutated by being asked, unlike a
// stateful dedup store. It has no dependency capable of executing a
// Task/workflow, calling Claude, touching git/GitHub, sending a Telegram
// message, or reaching ControllerCore/ExecutionPipeline/ApprovalEngine/
// BackgroundRuntime.
export class AutonomousPlanEvolutionEngine implements IAutonomousPlanEvolutionEngine {
  analyze(
    previous: AutonomousPlanHistoryEntry | undefined,
    currentPlan: AutonomousPlan,
    cycleNumber: number,
  ): AutonomousPlanEvolutionReport {
    // "resolved" is a one-time transition (see PlanItemChangeType's own
    // doc comment): a key already reported resolved is dropped from tracking
    // here, so it is never re-emitted just because the item is still absent,
    // and if it later reappears it is treated as "new" again, deliberately —
    // a concern that went away and came back is a fresh occurrence, not a
    // continuation of the old streak.
    const trackedPrevious = new Map(
      (previous?.evolution.transitions ?? [])
        .filter((transition) => transition.changeType !== "resolved")
        .map((transition) => [itemKey(transition.repositoryId, transition.sourceRecommendationKind), transition]),
    );

    const transitions: AutonomousPlanItemTransition[] = currentPlan.items.map((item) =>
      this.toTransition(item, trackedPrevious.get(itemKey(item.repositoryId, item.sourceRecommendationKind))),
    );

    const currentKeys = new Set(currentPlan.items.map((item) => itemKey(item.repositoryId, item.sourceRecommendationKind)));
    for (const [key, transition] of trackedPrevious) {
      if (currentKeys.has(key)) {
        continue;
      }
      transitions.push({
        repositoryId: transition.repositoryId,
        sourceRecommendationKind: transition.sourceRecommendationKind,
        changeType: "resolved",
        cycleCount: transition.cycleCount,
        priority: transition.priority,
        category: transition.category,
      });
    }

    return {
      previousPlanId: previous?.plan.id,
      currentPlanId: currentPlan.id,
      cycleNumber,
      generatedAt: new Date(),
      transitions,
    };
  }

  private toTransition(
    item: AutonomousPlanItem,
    previous: AutonomousPlanItemTransition | undefined,
  ): AutonomousPlanItemTransition {
    if (!previous) {
      return {
        repositoryId: item.repositoryId,
        sourceRecommendationKind: item.sourceRecommendationKind,
        changeType: "new",
        cycleCount: 1,
        priority: item.priority,
        category: item.category,
      };
    }

    const changeType: PlanItemChangeType = this.isWorse(item, previous) ? "escalating" : "recurring";
    const transition: AutonomousPlanItemTransition = {
      repositoryId: item.repositoryId,
      sourceRecommendationKind: item.sourceRecommendationKind,
      changeType,
      cycleCount: previous.cycleCount + 1,
      priority: item.priority,
      category: item.category,
    };
    if (changeType === "escalating") {
      transition.previousPriority = previous.priority;
      transition.previousCategory = previous.category;
    }
    return transition;
  }

  // Reuses AutonomousPlanningEngine's own priority/category ordering rather
  // than defining a second one: priority first, then category as a
  // tie-break, exactly the same two-step comparison that engine already
  // applies for its own cross-repo ranking.
  private isWorse(current: AutonomousPlanItem, previous: AutonomousPlanItemTransition): boolean {
    const priorityDelta = PRIORITY_ORDER[current.priority] - PRIORITY_ORDER[previous.priority];
    if (priorityDelta !== 0) {
      return priorityDelta < 0;
    }
    return CATEGORY_ORDER[current.category] - CATEGORY_ORDER[previous.category] < 0;
  }
}
