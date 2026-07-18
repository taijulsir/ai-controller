# Configuration

All five files under `config/` are **required** — a missing file throws `ConfigFileNotFoundError`
the first time it's accessed. Every field documented below (unless marked optional) is
required and type-checked; a missing or wrong-typed field throws `ConfigValidationError` with
every problem for that file collected into one message. There is no defaulting logic anywhere
in the config system — nothing is silently filled in.

Load order per file (`YamlConfigLoader.load()`): file-not-found check → read + YAML parse
(`ConfigParseError` on invalid syntax) → `${VAR}` environment interpolation
(`MissingEnvironmentVariableError` if unset) → structural validation (`ConfigValidationError`).

## `config/controller.yaml`

```yaml
controller:
  name: Taijul AI Controller
  version: 1.0.0
  environment: development

workspace:
  root: /home/aiagent/projects

task:
  max_concurrent_jobs: 1
  timeout_minutes: 30

approval:
  mode: manual
  require_before_git_push: true
  require_before_pull_request: false

logging:
  enabled: true
  level: info
  directory: /home/aiagent/workspace/ai-controller/logs

memory:
  enabled: true
  directory: /home/aiagent/workspace/ai-controller/memory
```

| Field | Type | Notes |
|---|---|---|
| `controller.name` / `.version` / `.environment` | string | free-form; not validated against an enum |
| `workspace.root` | string | not currently read by any adapter path resolution — repository paths come from `config/repositories.yaml` directly |
| `task.max_concurrent_jobs` | number | see [EXECUTION_PIPELINE.md](./EXECUTION_PIPELINE.md#taskplanner) |
| `task.timeout_minutes` | number | per-task timeout; see the known limitation about unobserved `AbortSignal`s |
| `approval.mode` | string | only `"manual"` currently has any effect (enables gating at all); any other value disables approval entirely. Not enum-validated. |
| `approval.require_before_git_push` / `.require_before_pull_request` | boolean | see [EXECUTION_PIPELINE.md](./EXECUTION_PIPELINE.md#approvalengine) |
| `logging.*` | bool/string/string | **validated but not wired to any actual log output** — see [Unused fields](#unused-fields) |
| `memory.enabled` | boolean | if `false`, `ProjectMemoryService.record()` no-ops entirely |
| `memory.directory` | string | base directory for both `events.jsonl` and `autonomous-plans.jsonl` |

## `config/claude.yaml`

```yaml
provider:
  name: claude

cli:
  executable: claude

execution:
  approval_mode: acceptEdits
  max_execution_minutes: 30

session:
  resume_previous: false
```

| Field | Type | Notes |
|---|---|---|
| `provider.name` | string | informational only |
| `cli.executable` | string | binary name resolved on `PATH` when spawning Claude |
| `execution.approval_mode` | string | passed through as `--permission-mode` to the `claude` CLI verbatim; not enum-validated by this project |
| `execution.max_execution_minutes` | number | kills the Claude child process if exceeded |
| `session.resume_previous` | boolean | default for whether to pass `--continue`, overridable per-call by `ClaudeSessionManager` |

## `config/github.yaml`

```yaml
github:
  cli: gh

git:
  default_branch: main

pull_request:
  auto_create: true
  auto_merge: false
```

| Field | Type | Notes |
|---|---|---|
| `github.cli` | string | binary name for the GitHub CLI |
| `git.default_branch` | string | fallback base branch for PR creation |
| `pull_request.auto_create` / `.auto_merge` | boolean | **declared and validated but not read anywhere else in the codebase** — this phase only supports explicit `/create-pr`/`/list-prs` actions; automatically opening or merging a PR after a push is unimplemented |

## `config/telegram.yaml`

```yaml
telegram:
  enabled: true

bot:
  token: "${TELEGRAM_BOT_TOKEN}"

security:
  allowed_users:
    - "8078199876"

notifications:
  task_started: true
  task_completed: true
  task_failed: true
```

See [TELEGRAM.md](./TELEGRAM.md#configtelegramyaml-fields) for full behavioral detail.

| Field | Type | Required? |
|---|---|---|
| `telegram.enabled` | boolean | yes |
| `telegram.operator_chat_id` | number | **optional** — type-checked only if present, no default substituted |
| `bot.token` | string | yes |
| `security.allowed_users` | string[] | yes (may be empty, but an empty list breaks proactive-alert delivery) |
| `notifications.task_started` / `task_completed` / `task_failed` | boolean | yes, but currently inert — see [Unused fields](#unused-fields) |

## `config/repositories.yaml`

```yaml
repositories:
  ai-controller:
    name: AI Controller
    path: /home/aiagent/workspace/ai-controller
    default_branch: main

active_repository: ai-controller
```

| Field | Type | Required? |
|---|---|---|
| `repositories.<id>.name` / `.path` | string | yes, per entry |
| `repositories.<id>.default_branch` | string | optional — validated only if present |
| `active_repository` | string \| null | yes (may be explicitly `null` — no repository is active) |

Any number of repository ids may be added; `RepositoryRegistry` additionally requires each
`path` to exist on disk and contain a `.git` directory before considering that repository
registered.

## Environment variable interpolation

Any string value in any of the 5 YAML files may reference `${VARIABLE_NAME}` (letters/digits/
underscore, starting with a letter or underscore) — the whole parsed document is walked
recursively, not just specific known fields. Resolved from `process.env` at load time; an
unset variable throws immediately:

> Configuration file "\<filePath\>" references environment variable "${\<name\>}", but it is
> not set. Define it in your environment or in a .env file at the project root.

Only `config/telegram.yaml`'s `bot.token` currently uses this.

## `.env` loading

`src/index.ts`'s `loadEnvFile()` is the first statement in `bootstrap()`, using Node's native
`process.loadEnvFile()` (not a third-party `dotenv` package) against `<project root>/.env`. If
the file doesn't exist, this is a silent no-op — startup only fails later if a `${VAR}`
placeholder still can't resolve from whatever's actually in `process.env` (from `.env` or the
real shell environment). `.env` is gitignored; `.env.example` documents the one variable this
project currently needs:

```
TELEGRAM_BOT_TOKEN=your-telegram-bot-token-here
```

## `IConfigService`

```ts
interface IConfigService {
  getControllerConfig(): ControllerConfig;
  getClaudeConfig(): ClaudeConfig;
  getGithubConfig(): GithubConfig;
  getTelegramConfig(): TelegramConfig;
  getRepositories(): Repository[];
  reload(): void;
}
```

Each `get*` method lazily loads and validates its file once, then caches the result for the
life of the `ConfigService` instance. `reload()` unconditionally re-reads and re-validates
**all five files from disk**, atomically replacing the whole cache — no restart required, and
it genuinely picks up on-disk edits to any `config/*.yaml` file made while the process is
running.

**Nuance**: `reload()` re-reads YAML, not `.env`. `${VAR}` placeholders are resolved against
whatever is currently in `process.env` at reload time (live, not cached) — so an env var
changed by some other means between startup and `reload()` would be picked up — but the `.env`
*file* itself is loaded exactly once, at process bootstrap, and never re-read.

## Typed error classes (`src/config/errors.ts`)

| Error | Trigger |
|---|---|
| `ConfigFileNotFoundError` | one of the 5 expected files is missing |
| `ConfigParseError` | the file's contents aren't valid YAML |
| `ConfigValidationError` | parsed document fails structural/type checks (may report multiple issues at once) |
| `MissingEnvironmentVariableError` | a `${VAR}` placeholder's variable isn't set |

## Unused fields

Declared, validated, and currently inert — kept in the schema but read by nothing else in the
codebase today:

- `config/github.yaml`: `pull_request.auto_create`, `pull_request.auto_merge`
- `config/telegram.yaml`: `notifications.task_started`, `notifications.task_completed`, `notifications.task_failed`
- `config/controller.yaml`: `logging.enabled`, `logging.level`, `logging.directory` — all
  current logging goes to stdout/stderr, never to a file; see
  [DEPLOYMENT.md](./DEPLOYMENT.md#logging)
- `config/controller.yaml`: `workspace.root` — not read by any current repository-path
  resolution path

## Hardcoded values not exposed via config

Each of the following is a numeric default kept as an internal constant, with an in-code
comment noting it as a deliberate "promote to config later if ever needed" decision, not an
oversight:

| Value | Constant / location | Current default |
|---|---|---|
| Claude session idle timeout | `ClaudeSessionManager` | 30 minutes |
| Telegram approval timeout | `TelegramConstants.APPROVAL_TIMEOUT_MINUTES` | 15 minutes |
| Stale-branch / repeated-failure thresholds | `DecisionEngine` | behind > 5, commit age > 14 days, ≥2 repeats, ≥2 warnings for "risky situation" |
| Quiet hours / notification cooldown / rate limit | `RuntimePolicyEngine` (`DEFAULT_RUNTIME_POLICY_CONFIG`) | 22:00–07:00, 30 min per-repo cooldown, 5 notifications/hour global |
| Monitoring sustained-alert duration | `ProactiveMonitor` | 1 hour |
| Monitoring worker tick interval | `MonitoringWorker` | 15 minutes |
| Plan recording / autonomous execution tick interval | `AutonomousPlanRecordingWorker`, `AutonomousExecutionWorker` | 1 hour each |
| Autonomous execution recent-attempt window | `AutonomousExecutionWorker` | 1 hour |
| Chronic/escalation/flap thresholds | `AutonomousPlanningAnalysisEngine` | ≥5 cycles, ≥2 escalating, >1 reappearance |
| Health-check heartbeat tick interval *(Stage 4)* | `HealthCheckWorker` | 1 minute |

See [SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md) for what each of these governs. One Stage 4 addition
does *not* fit this table: the graceful-shutdown grace period is also a hardcoded default (10s)
but, unlike everything above, is overridable via the `SHUTDOWN_TIMEOUT_MS` environment variable
— see [DEPLOYMENT.md](./DEPLOYMENT.md#graceful-shutdown), not this file, since it's read
directly from `process.env` rather than through the YAML config system this document covers.
