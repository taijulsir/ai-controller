// One issue per failed check. Every check this module performs today is
// advisory (severity: "warning") — none of them stop bootstrap. "error" is
// kept in the union for a future check that genuinely should be fatal,
// rather than widening this type later; nothing currently produces it.
export interface EnvironmentValidationIssue {
  check: string;
  severity: "warning" | "error";
  message: string;
}

export interface EnvironmentValidationReport {
  issues: EnvironmentValidationIssue[];
  generatedAt: Date;
}
