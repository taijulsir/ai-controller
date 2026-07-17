import type { AutonomousPlan } from "../autonomy/types";
import type { IAutonomousPlanHistoryService } from "../planhistory/interfaces";
import type { IAutonomousPlanStateEngine } from "../planstate/interfaces";
import type { AutonomousPlanState } from "../planstate/types";
import type { IAutonomousPlanningService } from "./interfaces";
import type { AutonomousPlanCycleSummary, AutonomousPlanningSnapshot } from "./types";

// The consumer-facing façade over the recorded-planning domain
// (AutonomousPlanHistoryService, Phase 9.2, and AutonomousPlanStateEngine,
// Phase 9.3) — one dependency for ApplicationService (and, later, whatever
// runtime/scheduler phase needs this domain) instead of two, exposing three
// higher-level use cases instead of a one-for-one mirror of its two
// collaborators' own methods.
//
// Deliberately does NOT depend on IAutonomousPlanningEngine,
// IRepositoryRegistry, IRecommendationEngine, IRepositoryIntelligenceService,
// or IClaudeSessionManager, and never fetches a live AutonomousPlan itself —
// getPlanningStatus() receives one as a parameter, already computed by its
// caller. Phase 9.1's getAutonomousPlan() depends on machinery
// ApplicationService already owns for the unrelated recommendations/
// assistance domain; absorbing it here would mean either duplicating that
// fan-out or this class depending back on ApplicationService itself — a real
// construction-time cycle. Holding this boundary is a permanent design
// constraint, not just an initial choice: nothing should later give this
// class its own way to fetch a live plan.
//
// Never calls record() on the injected IAutonomousPlanHistoryService, even
// though that interface exposes it — recording, and when a planning cycle
// should be recorded, remain outside this class entirely, same as they are
// for ApplicationService itself.
export class AutonomousPlanningService implements IAutonomousPlanningService {
  constructor(
    private readonly historyService: IAutonomousPlanHistoryService,
    private readonly stateEngine: IAutonomousPlanStateEngine,
  ) {}

  async getCurrentPlanState(): Promise<AutonomousPlanState | undefined> {
    const latestEntry = await this.historyService.getLatestEntry();
    if (!latestEntry) {
      return undefined;
    }
    // The newest entry is active by definition — deriveStates() is called
    // on a one-element window rather than duplicating that labeling rule
    // here, so "active" is computed in exactly one place.
    return this.stateEngine.deriveStates([latestEntry])[0];
  }

  async getRecentCycles(limit?: number): Promise<AutonomousPlanCycleSummary[]> {
    const history = await this.historyService.getHistory(limit);
    const states = this.stateEngine.deriveStates(history);
    return history.map((entry, index) => ({ entry, state: states[index] }));
  }

  async getPlanningStatus(livePlan: AutonomousPlan): Promise<AutonomousPlanningSnapshot> {
    const activeEntry = await this.historyService.getLatestEntry();
    const currentState = activeEntry ? this.stateEngine.deriveStates([activeEntry])[0] : undefined;
    const comparison = this.stateEngine.compareToActive(livePlan, activeEntry);

    return { generatedAt: new Date(), plan: livePlan, currentState, comparison };
  }
}
