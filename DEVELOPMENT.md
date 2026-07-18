# Development

## Prerequisites

- Node.js 20.6+ (the codebase uses the built-in `fetch` API and `process.loadEnvFile`; this
  environment runs Node v24.18.0)
- The `git` CLI on `PATH`
- The `claude` CLI on `PATH` (for any workflow that calls Claude)
- The `gh` CLI on `PATH` (for pull request workflows)

## Setup

```bash
npm install
cp .env.example .env   # then fill in TELEGRAM_BOT_TOKEN
```

Configuration lives in `config/*.yaml` — see [CONFIGURATION.md](./CONFIGURATION.md) for the
full schema. All five files are required.

## npm scripts

| Script | Command | Purpose |
|---|---|---|
| `npm run dev` | `tsx watch src/index.ts` | runs the bootstrap directly from TypeScript, restarting on file change |
| `npm run build` | `tsc` | compiles `src/` to `dist/` per `tsconfig.json` |
| `npm start` | `node dist/index.js` | runs the compiled bootstrap |
| `npm run start:checked` | `bash scripts/start.sh` | same, plus shell-level Node-version/`dist/` existence checks first — see [DEPLOYMENT.md](./DEPLOYMENT.md) |
| `npm run health-check` | `tsx scripts/health-check.ts` | checks a *running* instance's heartbeat file; exits 0/1 — see [DEPLOYMENT.md](./DEPLOYMENT.md#health-checks) |
| `npm run backup-memory` | `bash scripts/backup-memory.sh` | tars `memory.directory` to a timestamped archive — see [DEPLOYMENT.md](./DEPLOYMENT.md#backup-guidance) |
| `npm run pm2:start` / `pm2:stop` / `pm2:logs` | `pm2 ...` | process supervision via `ecosystem.config.js` — see [DEPLOYMENT.md](./DEPLOYMENT.md#process-supervision-pm2) |

There is no `npm test` script — this project's test suite is the collection of standalone
verification scripts under `scripts/`, described below, not a conventional test runner.
`health-check`/`backup-memory`/`pm2:*` are operational tools, not tests — they're not part of
the verification suite below and aren't expected to be run during development.

## Type checking

```bash
npx tsc --noEmit
```

Note `tsconfig.json`'s `include` is `["src/**/*.ts"]` only — `scripts/*.ts` is **not**
type-checked by `tsc` at all (`npm run build` doesn't touch it either). A verification script
whose call sites drift out of sync with a changed constructor signature will not be caught by
the compiler; only running the script itself (or its assertions) surfaces the drift. Keep this
in mind if you change a public constructor signature — grep `scripts/` for its call sites
manually, since `tsc` won't do it for you.

## Verification scripts

`scripts/` contains standalone `tsx`-run scripts, one per major subsystem, each self-contained
(constructs real collaborators against real temp git repos / in-memory fakes at the true
external-I/O boundary — no real Claude API calls, no real GitHub network calls, no real
Telegram HTTP calls). Each prints `PASS`/`FAIL` lines for its own assertions and exits non-zero
on an uncaught error; a few (e.g. `verify-telegram-live-integration.ts`) only log `FAIL`
without throwing, so a clean process exit code alone doesn't guarantee every assertion passed —
grep the output for `FAIL` too when in doubt.

Run one script:

```bash
npx tsx scripts/verify-execution-pipeline.ts
```

Run the entire suite:

```bash
for f in scripts/verify-*.ts; do
  echo "=== $f ==="
  npx tsx "$f" || echo "FAILED: $f"
done
```

Current suite (37 scripts as of this writing — one per subsystem, including the two Stage 4
additions covering `src/startup/EnvironmentValidator.ts` and `src/runtime/HealthCheckWorker.ts`):

`verify-attention-dispatcher`, `verify-autonomous-execution-orchestrator`,
`verify-autonomous-execution-worker`, `verify-autonomous-planning-engine`,
`verify-background-runtime`, `verify-context-builder`, `verify-decision-engine`,
`verify-engineering-assistance-engine`, `verify-engineering-workspace`,
`verify-environment-validator`, `verify-execution-coordinator`, `verify-execution-pipeline`,
`verify-health-check-worker`, `verify-notifying-autonomous-execution-orchestrator`,
`verify-operator-approval-channel`, `verify-plan-history`, `verify-plan-history-tail-read`,
`verify-plan-readiness`, `verify-plan-recording`, `verify-plan-recording-worker`,
`verify-plan-sequencing`, `verify-plan-state`, `verify-planning-engine`,
`verify-proactive-monitor`, `verify-recommendation-engine`, `verify-repository-registry`,
`verify-runtime-administration`, `verify-runtime-control`, `verify-runtime-diagnostics`,
`verify-runtime-policy-engine`, `verify-runtime-queries`, `verify-runtime-reporting`,
`verify-runtime-status`, `verify-scheduling`, `verify-strategy-engine`,
`verify-telegram-autonomous-execution-trigger`, `verify-telegram-live-integration`.

`_verify-background-runtime-keepalive-child.ts` (leading underscore) is a child-process helper
spawned by `verify-background-runtime.ts`, not a standalone check — don't run it directly.

## Coding conventions

Full rationale is in [architecture.md](./architecture.md#principles) — in brief:

- Every module exposes its public contract as an `I*` interface; consumers depend on the
  interface, never the concrete class.
- Exactly one class per module owns file/process/network transport (`YamlConfigLoader`,
  `GitCommandRunner`, `ClaudeProcessRunner`, `TelegramApiClient`, ...).
- `src/index.ts` is the only file allowed to construct cross-module concrete collaborators
  (two narrow, documented per-request-factory exceptions exist — see architecture.md).
- Typed errors, not raw `ENOENT`/parser exceptions, cross module boundaries.
- A numeric threshold or interval you're tempted to add to `config/*.yaml` may already have a
  "kept internal for now" precedent elsewhere in the codebase — see
  [CONFIGURATION.md](./CONFIGURATION.md#hardcoded-values-not-exposed-via-config) before adding
  a new YAML section for something that fits that pattern.
- New task types: add a `Task` variant, a workflow class, one line in `WorkflowFactory` —
  nothing else changes. New front-ends: depend on `IExecutionPipeline`/`IApplicationService`
  exactly like `TelegramAdapter` does.

## Known limitations worth knowing before you extend this codebase

These are documented in depth in [SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md#known-gaps-and-dormant-capabilities)
and [EXECUTION_PIPELINE.md](./EXECUTION_PIPELINE.md#known-limitation) — surfaced here too so
they're visible before you start:

- Workflows accept but ignore their `AbortSignal` — a timed-out task's underlying Claude/git/
  GitHub call keeps running unobserved.
- `RuntimeControlService`'s pause/maintenance/disable-repository capabilities are fully
  implemented but not wired to any Telegram command or other trigger today.
- `ProjectMemoryService.getRecentEvents()` re-reads the whole `events.jsonl` file on every
  call; `AutonomousPlanHistoryService` already solves the same problem with a bounded tail
  read, which `ProjectMemoryService` could reuse.
- `ContextBuilder`'s output reaches `StrategyEngine` but only two derived booleans survive
  into `TaskExecutionStrategy`, and nothing downstream reads them.

## Project layout

See [architecture.md](./architecture.md#layered-dependency-graph) for the full module graph
and what each of the 45 `src/` directories owns (44 from the original phases, plus Stage 4's
`src/startup/`).
