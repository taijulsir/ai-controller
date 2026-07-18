import type { EnvironmentValidationReport } from "./types";

// A pure, read-only prerequisite check the composition root runs once at
// bootstrap, before the intelligence/execution/runtime clusters are built.
// Never fatal by itself and never decides what to do with what it finds —
// same mechanism-vs-policy split as everywhere else in this codebase:
// validate() only reports; src/index.ts decides whether/how to act on the
// report (today: log every issue and continue, matching this project's
// existing behavior of not gating startup on optional-CLI availability).
export interface IEnvironmentValidator {
  validate(): Promise<EnvironmentValidationReport>;
}
