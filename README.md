# AI Controller

An AI Controller that orchestrates Claude Code, Git/GitHub, and Telegram behind a single,
approval-gated execution pipeline. It receives a request — a parsed Telegram command, or an
hourly autonomous-execution trigger — resolves the target repository, runs the requested task
or multi-step workflow through Claude Code and/or git, and returns a structured result, with an
approval gate in front of sensitive operations like pushing changes or opening a pull request.
A parallel, read-only intelligence & memory layer tracks repository health, execution history,
active Claude sessions, and derived insights per repository, surfaced through on-demand
Telegram queries (`/status`, `/history`, `/insights`, `/session`, `/task`, `/recommendations`,
`/runtime *`) and — for a subset of recommendations — through fully autonomous, unattended
execution. A git safety layer (`/fetch`, `/sync`, `/merge`, `/branch`) and an undo mechanism
(`/undo`) round out engineering-task support alongside the core `/analyze`, `/implement`,
`/fix`, and `/ship` commands.

v1.0.0 has shipped. The project is now in a documentation/hardening phase, not active feature
development.

## Documentation

| Document | Covers |
|---|---|
| [architecture.md](./architecture.md) | Principles, module dependency graph, composition root |
| [SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md) | Intelligence & memory layer, autonomous planning/execution, runtime operations surface |
| [EXECUTION_PIPELINE.md](./EXECUTION_PIPELINE.md) | Task types, approval gating, the `"ship"` workflow, Strategy/Planning/Coordination |
| [TELEGRAM.md](./TELEGRAM.md) | Command reference, approval flow, security model |
| [TELEGRAM_COMMANDS.md](./TELEGRAM_COMMANDS.md) | Every command in plain language — what it does, when to use it, an example |
| [CONFIGURATION.md](./CONFIGURATION.md) | Every `config/*.yaml` field, validation rules, env var interpolation |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | Setup, npm scripts, running the verification suite, coding conventions |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Running in production, PM2/systemd supervision, health checks, backup & recovery |
| [PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md) | Step-by-step deploy/verify checklist (Stage 6) |
| [DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md) | Scenario-driven incident recovery runbook (Stage 6) |
| [PRODUCTION_READY.md](./PRODUCTION_READY.md) | Stage 6 production-readiness verification report |
| [RELEASE.md](./RELEASE.md) | The release checklist and tagging convention used to reach v1.0.0 |
| [CHANGELOG.md](./CHANGELOG.md) | Full phase-by-phase development history |

## Requirements

- Node.js 20.6+ (uses the built-in `fetch` API and `process.loadEnvFile`)
- The `git` CLI available on `PATH`
- The `claude` CLI available on `PATH` (for any workflow that calls Claude)
- The `gh` CLI available on `PATH` (for pull request workflows)

## Setup

```bash
npm install
cp .env.example .env   # then fill in the real values
```

Configuration lives in `config/*.yaml` — see [CONFIGURATION.md](./CONFIGURATION.md) for the
full schema, validation rules, and the `${VARIABLE_NAME}` environment-variable interpolation
syntax (e.g. `config/telegram.yaml`'s `bot.token: "${TELEGRAM_BOT_TOKEN}"`). `src/index.ts`
loads `.env` at startup if one exists at the project root; `.env` is git-ignored, so real
secrets never enter version control — only placeholders belong in `.env.example`.

### Configuration files

| File | Purpose |
|---|---|
| `config/controller.yaml` | Controller identity, workspace root, task concurrency/timeout, approval mode, logging (declared, not yet wired to file output), Project Memory storage |
| `config/claude.yaml` | Claude CLI executable name, execution timeout, session behavior |
| `config/github.yaml` | Git CLI name, default branch, pull request behavior (explicit create/list actions are wired up; `auto_create`/`auto_merge` are declared but not read) |
| `config/telegram.yaml` | Bot enable flag, bot token, allowed user IDs, optional operator chat id, notification toggles |
| `config/repositories.yaml` | Registered repositories (id → name/path/default branch) and which one is active |

All five files are required, validated on load, and reloadable at runtime through
`IConfigService.reload()` — full detail in [CONFIGURATION.md](./CONFIGURATION.md).

## Running

```bash
npm run dev    # tsx watch src/index.ts — runs the bootstrap directly from TypeScript
npm run build  # tsc — compiles to dist/
npm start      # node dist/index.js — runs the compiled bootstrap
```

`src/index.ts` wires up the full pipeline — configuration, repository registry, the
intelligence & memory cluster, the execution stack (approval-gated unconditionally), the
background runtime (monitoring, plan recording, and autonomous execution — all started
unconditionally, independent of whether Telegram is enabled), and finally the Telegram
long-polling transport, if `telegram.enabled: true`. See [architecture.md](./architecture.md#composition-root)
for the full wiring order and why several steps happen earlier than you might expect. A future
CLI or REST front-end would depend on `IExecutionPipeline`/`IApplicationService` exactly like
`TelegramAdapter` does.

## Project layout

```
config/          YAML configuration files — see CONFIGURATION.md
src/
  domain/        Shared domain types (Repository)
  config/        Reads and validates config/*.yaml — the only module that touches YAML/fs
  repositories/  Repository Registry — validated, queryable repository lookup
  git/           Git Adapter — the only module that shells out to the git CLI
  claude/        Claude Adapter — the only module that spawns the claude CLI
  github/        Github Adapter — the only module that shells out to the gh CLI
  planner/       Task Planner — dispatches a Task to one workflow class per task type
  controller/    Controller Core — the single entry point that executes anything
  approval/      Approval Engine — decorates Controller Core with an approval gate
  orchestration/ Workflow Orchestrator — runs the "ship" multi-step workflow
  pipeline/      Execution Pipeline — Strategy → Planning → Coordination → Controller Core
  strategy/ planning/ coordination/   the decision-support stack behind the pipeline
  telegram/      Telegram Adapter — commands, approval UX, long-polling transport
  intelligence/  Repository Intelligence — read-only repository snapshot
  memory/        Project Memory — records every execution to disk
  session/       Claude Session Manager
  executionstate/ Execution State Tracker — decorates Controller Core to track what's currently running
  undo/          Undo Service — reverses the most recent implement/fix task's file changes
  decisions/     Decision Engine — repository snapshot + history → typed insights
  context/       Context Builder — assembles execution context (narrowly consumed today)
  recommendations/ assistance/        recommendation synthesis and engineering-facing relabeling
  application/   Application Service — the read-only query facade behind every Telegram query
  autonomy/ plan/ plananalysis/ planhistory/ planreadiness/ plansequencing/
  scheduling/ planrecording/ planstate/   the descriptive autonomous-planning pipeline
  autonomousexecution/   the one seam where a recommendation becomes a real execution request
  runtime/       Background Runtime and its four always-on workers (incl. the health-check heartbeat)
  monitoring/ attention/ policy/       proactive detection, delivery, and governance
  status/ control/ admin/ diagnostics/ reporting/   the runtime operations query/administration surface
  workspace/     EngineeringWorkspace type — the "everything at once" composed view
  startup/       Environment Validator — advisory prerequisite checks run once at boot
scripts/         Standalone verification scripts, plus operational tools — see DEVELOPMENT.md/DEPLOYMENT.md
```

See [SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md) and [EXECUTION_PIPELINE.md](./EXECUTION_PIPELINE.md)
for what each of these actually does at the class/method level, and
[architecture.md](./architecture.md#layered-dependency-graph) for the full dependency graph.

Every module exposes its public contract as an interface (`IConfigService`,
`IRepositoryRegistry`, `IGitAdapter`, `IClaudeAdapter`, `IGithubAdapter`, `ITaskPlanner`,
`IControllerCore`, `IExecutionPipeline`, `IApprovalProvider`, `IRepositoryIntelligenceService`,
`IProjectMemoryService`, `IClaudeSessionManager`, `IDecisionEngine`, `IApplicationService`,
`IAutonomousExecutionOrchestrator`, `ITelegramClient`, ...) — consumers depend on these, never
on concrete classes or on YAML/git/claude/GitHub/Telegram implementation details directly.
