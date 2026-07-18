# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). Entries before v1.0.0
correspond to this project's own `phase-N-complete` git tags rather than semantic-version
releases — included here because they're the real, tagged development history, not because
each was independently published. All dates below are commit dates.

## [v1.0.0] — 2026-07-18

First tagged release. Includes everything from Phases 1–15 below, plus:

### Fixed
- **Approval bypass when `telegram.enabled: false`.** `BackgroundRuntime`'s always-on
  `AutonomousExecutionWorker` could previously reach `ControllerCore` without passing through
  `ApprovalEngine` whenever the Telegram transport itself was disabled, silently violating a
  configured `require_before_git_push: true` policy. `ApprovalEngine` is now wired
  unconditionally in the composition root, before the `telegram.enabled` check.
- **Unhandled `child_process` spawn error crashing the whole process.** `ClaudeProcessRunner`
  had no `"error"` listener on the spawned Claude process; a missing/misconfigured `claude`
  executable crashed the entire controller via Node's unhandled-event behavior. Now caught and
  surfaced as a normal rejected promise through `ClaudeAdapter`'s existing error handling.
- **Broken verification script.** `verify-telegram-live-integration.ts` had silently broken
  when `TelegramAdapter`'s constructor gained an `autonomousExecutionOrchestrator` parameter in
  Phase 12; repaired to match the current constructor signature.

## Phase 15 — 2026-07-17 (`phase-15-complete`)
- Added `NotifyingAutonomousExecutionOrchestrator`, closing the approval-to-outcome loop: when
  `operator_chat_id` is configured, the operator is notified of every autonomous-execution
  attempt's outcome.

## Phase 14 — 2026-07-17 (`phase-14-complete`)
- Added the optional operator approval channel: `telegram.operator_chat_id` lets an
  autonomously-triggered approval-gated step reach a real Telegram chat instead of failing
  closed by default.

## Phase 13 — 2026-07-17 (`phase-13-complete`)
- Added `AutonomousExecutionWorker` — the first autonomous (non-Telegram-triggered) execution
  trigger, ticking hourly against the top of the recorded planning schedule.

## Phase 12 — 2026-07-17 (`phase-12-complete`)
- Added the manual `/auto-execute` Telegram command, invoking
  `AutonomousExecutionOrchestrator` directly.

## Phase 11 — 2026-07-17 (`phase-11-complete`)
- Added `AutonomousExecutionOrchestrator` — the first execution-capable component in the
  autonomous-planning cluster, translating a `RepositoryReadyToShip` recommendation into a real
  `ExecutionPipeline` request.

## Phase 10.3 — 2026-07-17 (`phase-10.3-complete`)
- Added status reporting to `AutonomousPlanRecordingWorker`.

## Phase 10.2 — 2026-07-17 (`phase-10.2-complete`)
- Performance: replaced whole-file scans with bounded tail reads in
  `AutonomousPlanHistoryService`.

## Phase 10.1 — 2026-07-17 (`phase-10.1-complete`)
- Added `AutonomousPlanRecordingWorker` for continuous (hourly) plan recording.

## Phase 10 — 2026-07-17 (`phase-10-complete`)
- Added `AutonomousPlanRecordingService`, an explicit write path over the recorded-planning
  domain.

## Phase 9.8 — 2026-07-17 (`phase-9.8-complete`)
- Added `AutonomousPlanSchedulingEngine` — descriptive cadence classification.

## Phase 9.7 — 2026-07-17 (`phase-9.7-complete`)
- Added `AutonomousPlanSequencingEngine` — descriptive plan sequencing/ordering.

## Phase 9.6 — 2026-07-17 (`phase-9.6-complete`)
- Added `AutonomousPlanReadinessEngine` — descriptive execution readiness scoring.

## Phase 9.5 — 2026-07-17 (`phase-9.5-complete`)
- Added `AutonomousPlanningAnalysisEngine` — multi-cycle pattern analysis (chronic/escalating/
  flapping detection) over recorded plan history.

## Phase 9.4 — 2026-07-17 (`phase-9.4-complete`)
- Added `AutonomousPlanningService`, a consumer-oriented façade over the recorded-planning
  domain.

## Phase 9.3 — 2026-07-17 (`phase-9.3-complete`)
- Added `AutonomousPlanStateEngine` — plan state derivation and live comparison.

## Phase 9.2 — 2026-07-17 (`phase-9.2-complete`)
- Added `AutonomousPlanHistoryService` and `AutonomousPlanEvolutionEngine` — autonomous plan
  history persistence and cycle-to-cycle evolution tracking.

## Phase 9.1 — 2026-07-17 (`phase-9.1-complete`)
- Added `AutonomousPlanningEngine`, the first (read-only) autonomous planning engine.

## Phase 8 — 2026-07-16 (`phase-8-complete`)
- Added `BackgroundRuntime`, `RuntimePolicyEngine`, `RuntimeDiagnosticsEngine`,
  `RuntimeReportingEngine` — background worker infrastructure, governance policy, and the
  runtime diagnostics/reporting surface.

## Phase 7 — 2026-07-15 (`phase-7-complete`)
- Added the decision pipeline (`StrategyEngine`/`PlanningEngine`/`ExecutionCoordinator`),
  `ExecutionPipeline`, and the read-side intelligence surface (`ApplicationService`,
  `RecommendationEngine`).

## Phase 6 — 2026-07-15 (`phase-6-complete`)
- Added `RepositoryIntelligenceService`, `ProjectMemoryService`, and `DecisionEngine` — the
  read-only intelligence & memory layer.

## Phase 5 — 2026-07-14 (`phase-5-complete`)
- Added `WorkflowOrchestrator`/`WorkflowRegistry` and the `"ship"` multi-step workflow.

## Earlier history — 2026-07-13
- `feat(github)`: pull request integration (`GithubAdapter`, `CreatePullRequestWorkflow`,
  `ListPullRequestsWorkflow`).
- `feat(approval)`: the Telegram approval workflow (`ApprovalEngine`,
  `TelegramApprovalProvider`).
- `feat(telegram)`: the long-polling transport with structured logging.
- `feat(config)`: `.env` loading and YAML environment-variable substitution.
- Initial commit: AI controller with real Claude Code CLI integration — the original
  `domain → config → repositories → git/claude/github → planner → controller` pipeline.
