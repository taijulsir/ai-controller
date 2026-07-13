# Architecture

## Principles

- **Interfaces first.** Every module exposes an `I*` interface as its public contract.
  Consumers depend on the interface, never on the concrete class or on the module's
  internal implementation details (YAML parsing, shelling out to `git`/`claude`, HTTP
  calls to Telegram, ...).
- **One class, one job.** File-transport/process-execution is isolated behind exactly one
  class per module (`YamlConfigLoader`, `GitCommandRunner`, `ClaudeProcessRunner`,
  `TelegramApiClient`) — nothing else in the codebase touches `fs`, `child_process`, or
  `fetch` directly.
- **Mechanism vs. policy.** Adapters (`GitAdapter`, `ClaudeAdapter`), the planner, and
  `ControllerCore` never read approval configuration and never decide whether an action
  is *allowed* — they only know how to *do* it. Exactly one module (`ApprovalEngine`)
  owns approval policy, implemented as a decorator around `IControllerCore` so gating any
  front-end is a composition-time choice, not a code change.
- **Fail fast, fail clearly.** Every module defines its own typed errors with
  human-readable messages (missing config file, invalid YAML, repository path doesn't
  exist, git command failed, unknown task type, ...) rather than letting raw
  `ENOENT`/parser exceptions leak out.

## Layered dependency graph

Strictly acyclic — each layer only depends on the ones before it:

```
domain  →  config  →  repositories  →  git, claude, github  →  planner  →  controller  →  approval, telegram
```

- **`domain`** — the shared `Repository` type used by every module above it.
- **`config`** — `ConfigService` reads and validates `config/*.yaml`. Nothing else in the
  codebase reads YAML or touches the `config/` directory directly.
- **`repositories`** — `RepositoryRegistry` turns `ConfigService.getRepositories()` into a
  validated, queryable lookup (each repository's path must exist and contain a `.git`
  directory before it's considered registered).
- **`git`** — `GitAdapter` runs `status`, `currentBranch`, `checkout`, `createBranch`,
  `stageAll`, `commit`, `push`, `pull` against a repository resolved from
  `IRepositoryRegistry`, via `git`'s CLI only (no GitHub API calls).
- **`claude`** — `ClaudeAdapter` runs `execute`/`stream` against the `claude` CLI for a
  repository resolved from `IRepositoryRegistry`, with `{ continue: boolean }` mapping
  directly onto the CLI's own `--continue` flag rather than an invented session concept.
- **`github`** — `GithubAdapter` runs `pr create`/`pr view`/`pr list` via the `gh` CLI
  (executable name from `GithubConfig.github.cli`) against a repository resolved from
  `IRepositoryRegistry`, exactly like `GitAdapter`/`ClaudeAdapter`. `PullRequestMapper` is
  the one place that turns `gh`'s JSON output into the domain `PullRequestSummary` shape —
  `GithubAdapter` itself only orchestrates. `github.yaml`'s `pull_request.auto_create` and
  `auto_merge` are intentionally unread today — this phase only supports explicit
  create/list actions; automatically opening or merging a PR after a push is a deliberate
  future extension, not implemented.
- **`planner`** — `TaskPlanner` dispatches a `Task` (`analyze-repository`, `explain-code`,
  `implement-feature`, `fix-bug`, `create-commit`, `push-changes`, `create-pull-request`,
  `list-pull-requests`) to one small workflow class per task type, built by
  `WorkflowFactory`. Enforces `ControllerConfig.task`'s concurrency limit and per-task
  timeout.
- **`controller`** — `ControllerCore` is the single entry point every future front-end
  calls: resolve the repository, build the planner's execution context, delegate, return
  an `ExecutionResult`.
- **`approval`** — `ApprovalEngine implements IControllerCore`, wrapping a real one. Reads
  `ControllerConfig.approval` to decide whether a request needs approval, and — if so —
  awaits an `IApprovalProvider` before ever calling the wrapped `ControllerCore`.
- **`telegram`** — `TelegramAdapter` parses a message into a `Task`, calls `IControllerCore`
  (whichever concrete instance — plain or approval-gated — was wired at startup), and
  sends the formatted result back. Knows nothing about git, Claude, YAML, or the planner's
  internals.

## Composition root

`src/index.ts` is the only file that constructs concrete classes and wires them together
(`ConfigService → RepositoryRegistry → WorkflowFactory → TaskPlanner → ControllerCore`).
No other module is allowed to reach past its declared interface dependencies to construct
its own collaborators from other modules.

## Extension points already designed for

- **Approval providers** (Telegram inline buttons, a web dashboard, a CLI prompt) are all
  just new `IApprovalProvider` implementations — `ApprovalEngine` doesn't change.
  `TelegramApprovalProvider` (in `src/telegram/`) is the first one: it tracks pending
  approvals in memory only, keyed by `correlationId` — a controller restart loses any
  request that hasn't been approved/rejected yet.
- **Streaming / progress updates in Telegram**: `ITelegramClient` can grow an
  `editMessage()` method additively; `ClaudeAdapter.stream()` already exists for the
  planner to build a streaming workflow on top of.
- **Cancellation**: `TaskPlanner.run()` already threads an `AbortSignal` into every
  workflow call, unused today but ready for adapters to observe later.
- **New task types**: add a `Task` variant, a workflow class, and one line in
  `WorkflowFactory` — nothing else changes.
- **New front-ends** (CLI, REST API): depend on `IControllerCore` exactly like
  `TelegramAdapter` does; translate your transport in, translate `ExecutionResult` back out.
