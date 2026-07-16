// Shared three-tier severity vocabulary. Introduced here (rather than
// imported from decisions' repository-specific Insight, or duplicated as
// identical literals) because it is not owned by any one domain: decisions'
// InsightSeverity and diagnostics' DiagnosticFinding both need the same
// three values for genuinely different reasons (repository insight severity
// vs. runtime health severity), and neither domain should depend on the
// other's module for a vocabulary this generic.
export type Severity = "info" | "warning" | "critical";
