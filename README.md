# AI Controller

An AI Controller that orchestrates Claude Code, Git/GitHub, and Telegram behind a single,
policy-free execution pipeline. It receives a request (today: a parsed Telegram command),
resolves the target repository, runs the requested task through Claude Code and/or git,
and returns a structured result — with an optional approval gate in front of sensitive
operations like pushing changes.

See [architecture.md](./architecture.md) for the full module breakdown and design principles.

## Requirements

- Node.js 18+ (uses the built-in `fetch` API)
- The `git` CLI available on `PATH`
- The `claude` CLI available on `PATH` (for any workflow that calls Claude)

## Setup

```bash
npm install
```

Configuration lives in `config/*.yaml` (see below) — nothing is read from environment
variables today.

### Configuration files

| File                        | Purpose                                                                              |
|-----------------------------|---------------------------------------------------------------------------------------|
| `config/controller.yaml`    | Controller identity, workspace root, task concurrency/timeout, approval mode, logging |
| `config/claude.yaml`        | Claude CLI executable name, execution timeout, session behavior                       |
| `config/github.yaml`        | Git CLI name, default branch, pull request behavior (not yet wired up)                |
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

`src/index.ts` wires up the core pipeline (`ConfigService → RepositoryRegistry →
WorkflowFactory → TaskPlanner → ControllerCore`) and logs the registered repositories on
startup. No transport (Telegram, CLI, REST) is wired into the bootstrap yet — those are
future entry points that will each call `IControllerCore.execute()`.

## Project layout

```
config/          YAML configuration files
src/
  domain/        Shared domain types (e.g. Repository)
  config/        Reads and validates config/*.yaml — the only module that touches YAML/fs
  repositories/  Repository Registry — validated, queryable repository lookup
  git/           Git Adapter — the only module that shells out to the git CLI
  claude/        Claude Adapter — the only module that spawns the claude CLI
  planner/       Task Planner — orchestrates git/claude adapters into named workflows
  controller/    Controller Core — the single entry point every future front-end calls
  approval/      Approval Engine — decorates Controller Core with an approval gate
  telegram/      Telegram Adapter — parses commands and calls Controller Core
scripts/         Standalone verification scripts (not part of the build)
```

Every module exposes its public contract as an interface (`IConfigService`,
`IRepositoryRegistry`, `IGitAdapter`, `IClaudeAdapter`, `ITaskPlanner`, `IControllerCore`,
`IApprovalProvider`, `ITelegramClient`, ...) — consumers depend on these, never on
concrete classes or on YAML/git/claude/Telegram implementation details directly.
