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

## Intelligence & memory layer (Phase 6)

A second, independent cluster of read-only modules sits beside the execution pipeline
described above. These modules observe repository state and execution history — none of
them shells out to `git`/`gh`/`claude` to *change* anything, and none of them gates or
performs an action itself. Their own acyclic graph:

```
repositories, config, git, github, approval             →  intelligence
repositories, config                                     →  memory
(no dependencies)                                         →  session
intelligence, memory, session                             →  decisions
intelligence, memory                                       →  context
intelligence, memory, decisions, session, repositories    →  application
```

- **`intelligence`** — `RepositoryIntelligenceService` builds a `RepositorySnapshot`
  (branch ahead/behind, working-tree state, recent commits, open pull requests, a
  `RepositoryHealth` summary, and a `WorkflowReadiness` verdict) by running
  `GitAdapter.status()`, the new `GitAdapter.getRecentCommits()` (parsed by the new
  `GitLogParser`), and `GithubAdapter.listOpenPullRequests()` concurrently via
  `Promise.allSettled` — a failure in any one source degrades that section of the snapshot
  into an `issues` entry instead of failing the whole snapshot. Reuses the existing
  `ApprovalPolicy` (the policy predicate `ApprovalEngine` itself is built on) to answer
  "would push/PR require approval right now?" without depending on the `ApprovalEngine`
  decorator.
- **`memory`** — `ProjectMemoryService` appends one JSON line per execution to
  `memory.directory/events.jsonl` (`ControllerConfig.memory`, new in `controller.yaml`) and
  reads them back newest-first for `getRecentEvents()`. `MemoryRecordingControllerCore`
  decorates `IControllerCore` exactly like `ApprovalEngine` does — it never changes the
  outcome it wraps; a failed memory write is caught and logged, never surfaced to the caller.
- **`session`** — `ClaudeSessionManager` is a pure in-memory metadata/policy store (no
  adapter, no config, no `fs`): one record per repository (`id`, `createdAt`, `lastUsedAt`),
  expired after 30 minutes of inactivity. `resolveSession()` is the single source of truth for
  whether the next `ClaudeAdapter.execute()` call should pass `{ continue: true }` —
  `WorkflowFactory` now takes an `IClaudeSessionManager` and asks it this question instead of
  hardcoding `continue: false` (`WorkflowFactory.resolveShouldContinue()`).
- **`decisions`** — `DecisionEngine.analyze()` combines a repository's snapshot, recent
  `ProjectMemoryEvent`s, and its `ClaudeSessionInfo` into typed `Insight`s (unclean working
  tree, unpushed commits, stale branch, unfinished workflow, repeated failures, approval
  required, open PRs, expired session, and a derived "risky situation" when two or more
  warning/critical insights co-occur). Every insight carries a `notificationWorthy` flag —
  computed today, but nothing pushes on it yet; see "Extension points" below.
- **`context`** — `ContextBuilder.build()` assembles an `ExecutionContext` (repository
  snapshot plus recent/task-relevant `ProjectMemoryEvent`s) for a prospective execution. Fully
  implemented and independently testable, but **not yet called by any workflow or the
  planner** — a deliberate Phase 6 stopping point, not an oversight; see "Extension points".
- **`application`** — `ApplicationService` is the read-only query facade: it does not
  implement `IControllerCore` and never calls `execute()`. It resolves "which repository"
  once (explicit id, else the registry's active repository, else `NoActiveRepositoryError`)
  and fans out to `intelligence`/`memory`/`decisions`/`session` for `getRepositoryStatus`,
  `getRepositoryHistory`, `getRepositoryInsights`, and `getSessionStatus`.

`telegram` now depends on this cluster as well as on the execution pipeline:
`TelegramAdapter` takes both `IControllerCore` (for `task`/`workflow` commands) and
`IApplicationService` (for the new read-only `status` / `history` / `insights` / `session`
commands) side by side — `CommandParser` routes each parsed message to exactly one of
`{ task, workflow, query }`, and `ResponseFormatter` grew one formatting method per query
type. Outgoing replies now go through `TelegramMessageSplitter.splitMessageText()` first,
since a formatted status/history/insights reply can exceed Telegram's 4096-character message
limit (`TELEGRAM_MAX_MESSAGE_LENGTH`) in a way a short task result rarely did.

## Composition root

`src/index.ts` is the only file that constructs concrete classes and wires them together. No
other module is allowed to reach past its declared interface dependencies to construct its own
collaborators from other modules.

Construction happens in two groups. The intelligence & memory cluster is built first —
`RepositoryIntelligenceService`, `ProjectMemoryService`, `ClaudeSessionManager`,
`DecisionEngine`, `ApplicationService` — since none of it depends on the execution pipeline.
The execution pipeline is then built as before (`ConfigService → RepositoryRegistry →
WorkflowFactory → TaskPlanner → ControllerCore`, with `WorkflowFactory` now also taking the
`ClaudeSessionManager`), decorated outward through `ApprovalEngine` and then
`MemoryRecordingControllerCore` — recording wraps the *outermost* layer so every execution
that crosses it (standalone tasks, whole workflows, and each individual workflow step
re-entering through `DeferredControllerCore`) gets a Project Memory event, without
`ControllerCore` / `ApprovalEngine` / `WorkflowOrchestrator` changing at all. `TelegramAdapter`
receives this fully decorated `IControllerCore` alongside the plain `ApplicationService` —
queries never need approval-gating or memory-recording, since they don't change anything.

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
- **Context-aware execution**: `ContextBuilder` already assembles the `ExecutionContext` a
  workflow would need (repository snapshot + relevant history) — wiring it into
  `WorkflowFactory`/the planner so Claude-backed workflows fold it into their prompts is a
  deliberate next step, not implemented yet.
- **Proactive notifications**: `Insight.notificationWorthy` and
  `RepositoryInsightReport.notificationWorthyInsights` are already computed by
  `DecisionEngine` — nothing polls repositories on a schedule and pushes them to Telegram yet;
  today they're only visible via the on-demand `/insights` command.
