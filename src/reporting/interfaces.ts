import type { RuntimeDiagnosticsReport } from "../diagnostics/types";
import type { RuntimeStatus } from "../status/types";
import type { RuntimeReport } from "./types";

export interface IRuntimeReportingEngine {
  buildReport(status: RuntimeStatus, diagnostics: RuntimeDiagnosticsReport): RuntimeReport;
}
