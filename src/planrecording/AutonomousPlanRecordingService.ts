import type { AutonomousPlan } from "../autonomy/types";
import type { IAutonomousPlanHistoryService } from "../planhistory/interfaces";
import type { AutonomousPlanHistoryEntry } from "../planhistory/types";
import type { IAutonomousPlanRecordingService } from "./interfaces";

// Phase 10: the first intentional write path over the recorded-planning
// domain. Holds only IAutonomousPlanHistoryService — the same domain-storage
// dependency AutonomousPlanningService (the read façade) already holds — and
// does nothing but delegate to its record() method, the one place a
// planning cycle has ever been written since Phase 9.2. Owns no resource of
// its own: AutonomousPlanHistoryService keeps sole ownership of the
// underlying storage (the .jsonl file and its directory), exactly as before
// this class existed.
//
// Deliberately does not depend on IAutonomousPlanningService,
// IRepositoryRegistry, IRecommendationEngine, or IAutonomousPlanningEngine —
// it never synthesizes a live plan itself, the same permanent boundary
// AutonomousPlanningService holds on the read side (see its own doc
// comment). ApplicationService obtains the live AutonomousPlan via its
// existing getAutonomousPlan() workflow and hands it in already-built; this
// class only ever records what it is given.
export class AutonomousPlanRecordingService implements IAutonomousPlanRecordingService {
  constructor(private readonly historyService: IAutonomousPlanHistoryService) {}

  async recordAutonomousPlanCycle(plan: AutonomousPlan): Promise<AutonomousPlanHistoryEntry> {
    return this.historyService.record(plan);
  }
}
