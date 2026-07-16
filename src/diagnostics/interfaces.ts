import type { RuntimeStatus } from "../status/types";
import type { RuntimeDiagnosticsReport } from "./types";

export interface IRuntimeDiagnosticsEngine {
  diagnose(status: RuntimeStatus): RuntimeDiagnosticsReport;
}
