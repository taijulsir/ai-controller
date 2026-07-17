import type { AutonomousPlan } from "../autonomy/types";
import type { AutonomousPlanHistoryEntry } from "../planhistory/types";

// Phase 10: the one explicit write-facing entry point over the
// recorded-planning domain — a sibling to IAutonomousPlanningService (the
// read-facing façade, Phase 9.4), not a method added to it. See
// AutonomousPlanningService's own doc comment for why that façade
// permanently excludes record(). Named recordAutonomousPlanCycle(), not
// record(), so every call site reads unambiguously as a write, distinct
// from the get*() read surface IApplicationService/IAutonomousPlanningService
// otherwise expose exclusively.
//
// Takes an already-synthesized AutonomousPlan rather than fetching one
// itself — the same "caller supplies the live plan" shape
// AutonomousPlanningService.getPlanningStatus() already uses. This service
// never depends on whatever synthesizes a live plan (repository fan-out,
// recommendations, AutonomousPlanningEngine); obtaining that plan remains
// its caller's (ApplicationService's) responsibility.
export interface IAutonomousPlanRecordingService {
  recordAutonomousPlanCycle(plan: AutonomousPlan): Promise<AutonomousPlanHistoryEntry>;
}
