<!-- This project is under active development; see architecture.md for design details. -->

# AI Controller

An AI Controller that orchestrates Claude Code, Git/GitHub, and Telegram behind a single,
policy-free execution pipeline. It receives a request (today: a parsed Telegram command),
resolves the target repository, runs the requested task or multi-step workflow through Claude
Code and/or git, and returns a structured result — with an optional approval gate in front of
sensitive operations like pushing changes. A parallel, read-only intelligence & memory layer
tracks repository health, execution history, active Claude sessions, and derived insights per
repository, surfaced today through on-demand Telegram queries (`/status`, `/history`,
`/insights`, `/session`).

See [architecture.md](./architecture.md) for the full module breakdown and design principles.

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

Configuration lives in `config/*.yaml` (see below). Any YAML value can reference an
environment variable with `${VARIABLE_NAME}` syntax — e.g. `config/telegram.yaml`'s
`bot.token: "${TELEGRAM_BOT_TOKEN}"` — which is resolved from `process.env` when the file
loads, and raises a clear error if the variable isn't set. `src/index.ts` loads `.env` at
startup if one exists at the project root; `.env` is git-ignored, so real secrets never
enter version control — only placeholders belong in `.env.example`.

### Configuration files

| File                        | Purpose                                                                              |
|-----------------------------|---------------------------------------------------------------------------------------|
| `config/controller.yaml`    | Controller identity, workspace root, task concurrency/timeout, approval mode, logging, Project Memory storage |
| `config/claude.yaml`        | Claude CLI executable name, execution timeout, session behavior                       |
| `config/github.yaml`        | Git CLI name, default branch, pull request behavior (explicit create/list actions are wired up; `auto_create`/`auto_merge` are not) |
| `config/telegram.yaml`      | Bot enable flag, bot token, allowed user IDs, notification toggles                     |
| `config/repositories.yaml`  | Registered repositories (id → name/path/default branch) and which one is active       |

All five files are required, validated on load, and reloadable at runtime through
`IConfigService.reload()` — see `src/config/`.

## Running

```bash
npm run dev    # tsx watch src/index.ts — runs the bootstrap directly from TypeScript
npm run build  # tsc — compiles to dist/
npm start      # node dist/index.js — runs the compiled bootstrap
```

`src/index.ts` wires up the full pipeline — configuration, repository registry, the
intelligence & memory cluster (Repository Intelligence, Project Memory, Claude Session
Manager, Decision Engine, Application Service), the task planner and workflow orchestrator,
approval gating, and Project Memory recording — then starts the Telegram long-polling
transport (unless `telegram.enabled: false` in `config/telegram.yaml`, in which case it logs
the registered repositories and exits instead). See [architecture.md](./architecture.md) for
the full composition-root wiring order. A future CLI or REST front-end would depend on
`IControllerCore`/`IApplicationService` exactly like `TelegramAdapter` does.

## Project layout

```
config/          YAML configuration files
src/
  domain/        Shared domain types (e.g. Repository)
  config/        Reads and validates config/*.yaml — the only module that touches YAML/fs
  repositories/  Repository Registry — validated, queryable repository lookup
  git/           Git Adapter — the only module that shells out to the git CLI
  claude/        Claude Adapter — the only module that spawns the claude CLI
  github/        Github Adapter — the only module that shells out to the gh CLI
  planner/       Task Planner — orchestrates git/claude/github adapters into named workflows
  orchestration/ Workflow Orchestrator — runs a named multi-step workflow (e.g. "ship") as a
                 sequence of tasks through Controller Core
  controller/    Controller Core — the single entry point every future front-end calls
  approval/      Approval Engine — decorates Controller Core with an approval gate
  intelligence/  Repository Intelligence — read-only repository snapshot (branch, working
                 tree, commits, PRs, health, workflow readiness)
  memory/        Project Memory — records every execution to disk; decorates Controller Core
  session/       Claude Session Manager — tracks whether the next Claude call should continue
                 an existing session
  decisions/     Decision Engine — turns a repository snapshot + history into typed insights
  context/       Context Builder — assembles repository + history context for a prospective
                 execution (not yet wired into the planner)
  application/   Application Service — read-only query facade over intelligence/memory/
                 decisions/session, used by Telegram's status/history/insights/session commands
  telegram/      Telegram Adapter — parses commands/workflows/queries and calls Controller
                 Core or Application Service
scripts/         Standalone verification scripts (not part of the build)
```

Every module exposes its public contract as an interface (`IConfigService`,
`IRepositoryRegistry`, `IGitAdapter`, `IClaudeAdapter`, `IGithubAdapter`, `ITaskPlanner`,
`IControllerCore`, `IApprovalProvider`, `IRepositoryIntelligenceService`,
`IProjectMemoryService`, `IClaudeSessionManager`, `IDecisionEngine`, `IApplicationService`,
`ITelegramClient`, ...) — consumers depend on these, never on concrete classes or on
YAML/git/claude/GitHub/Telegram implementation details directly.
