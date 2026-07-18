# Project Journey — From VM to Production

> This document tells the story of how the AI Controller went from an empty machine to a
> permanently-running production process, in plain language, in the order it actually happened.
> It's a companion to the detailed technical docs (`architecture.md`, `SYSTEM_DESIGN.md`,
> `EXECUTION_PIPELINE.md`, `TELEGRAM.md`, `CONFIGURATION.md`, `DEPLOYMENT.md`), which describe
> *how* things work today. This document explains *why* each step happened, in the order it was
> built, so a newcomer can follow the reasoning instead of just the result.

## What the AI Controller actually is

A single Node.js program that lets you drive Claude Code, git, and GitHub from Telegram. You
message a bot ("implement dark mode", "ship this change"), it runs the work against a real
repository on disk, and — for anything sensitive like pushing code or opening a pull request —
it asks you to approve it first with a button tap. It also watches your repositories in the
background and can, within limits, act on its own.

---

## 1. VM / host setup

Before any code existed, the host machine needed a few things ready. This part isn't scripted
anywhere in this repository — it's a set of prerequisites the project simply assumes are true,
documented in `README.md`'s "Requirements" section:

- **Node.js 20.6 or newer** — the project relies on Node's built-in `fetch` and
  `process.loadEnvFile`, so it won't run on an older runtime.
- **The `git` CLI on `PATH`** — every commit/push/status operation shells out to it directly.
- **The `claude` CLI on `PATH`** — required for any workflow that talks to Claude Code
  (analyze, explain, implement, fix).
- **The `gh` CLI on `PATH`** — required for pull-request workflows.
- **A writable directory for application data** — used later for logs, memory, and backups.

There is no VM provisioning script, Dockerfile, or infrastructure-as-code in this repository.
Getting a host to this state was a manual, one-time setup step, not something the application
automates.

## 2. Project bootstrap

The first real commit (`Initial commit: AI controller with real Claude Code CLI integration`)
laid down the shape everything else was built on: a layered pipeline —

```
config → repositories → git/claude/github → planner → controller → approval/telegram
```

At this stage the controller could already do the core thing: take a task, run it through
Claude Code's real CLI (`claude --print --output-format stream-json`, parsed as streaming
NDJSON), and execute it — with an approval-gated decorator already in front of the execution
core from day one, not bolted on later. This "policy-free core, approval as a wrapper" shape is
why every later feature could be added without ever having to retrofit safety.

Two small but important fixes followed almost immediately:
- **`Register ai-controller as the active repository`** — pointed `config/repositories.yaml` at
  this project's own working copy, so the controller could operate on itself.
- **`Disable Claude session auto-resume`** — turned off automatic session resumption to avoid
  two different requests accidentally colliding on the same Claude session.

## 3. Config setup

Configuration was deliberately kept in five plain YAML files under `config/`, each validated on
load and each with one clear job:

| File | What it controls |
|---|---|
| `controller.yaml` | Identity, workspace root, task concurrency/timeout, approval mode, memory storage |
| `claude.yaml` | Which `claude` executable to run, execution timeout, session behavior |
| `github.yaml` | Which `gh` executable to run, default branch, PR behavior |
| `telegram.yaml` | Bot on/off, bot token, who's allowed to use it, notification toggles |
| `repositories.yaml` | Which repositories the controller knows about, and which one is "active" |

A later commit (`feat(config): support .env loading and YAML environment variable
substitution`) added `${VARIABLE_NAME}` interpolation — so a real secret (the Telegram bot
token) never has to be written directly into a YAML file. `.env` holds the real value,
`.env.example` documents the placeholder, and `.env` is git-ignored so secrets never enter
version control. A missing config file, invalid YAML, or an unresolved `${VAR}` reference all
fail startup immediately with a specific, named error — the project never starts up in a
half-configured state.

## 4. Telegram setup

Telegram was added as the primary way to actually talk to the controller, in a few steps:

1. **`feat(telegram): add long-polling transport with structured logging`** — the bot fetches
   updates itself, every 30 seconds, rather than requiring a public webhook URL. This means the
   controller never has to open an inbound network port.
2. **`feat(approval): implement Telegram approval workflow`** — sensitive steps (pushing code,
   opening a pull request) now pause and send an inline "✅ Approve / ❌ Reject" prompt to an
   authorized Telegram user before continuing.
3. **Authorization** — every command and every button press is checked against
   `security.allowed_users` in `config/telegram.yaml`. An unrecognized user gets a fixed refusal
   message and nothing runs.

See `TELEGRAM_COMMANDS.md` for the full list of what you can actually type into the bot today.

## 5. Architecture phases (5 through 15)

Once the bootstrap, config, and Telegram foundation existed, the project grew through a series
of numbered phases — each one tagged (`phase-N-complete`) as its own milestone. In order:

- **Phase 5 — Ship workflow.** Added `WorkflowOrchestrator` and the first multi-step workflow,
  `"ship"`: verify status → commit → push → open PR, as one command (`/ship <message>`) instead
  of four.
- **Phase 6 — Intelligence & memory layer.** Added `RepositoryIntelligenceService` (read-only
  repository snapshots), `ProjectMemoryService` (a durable, append-only log of every execution),
  and `DecisionEngine` (turns snapshots + history into typed insights). This is what later makes
  `/status`, `/history`, and `/insights` possible.
- **Phase 7 — Decision pipeline.** Added `StrategyEngine` → `PlanningEngine` →
  `ExecutionCoordinator`, plus `ExecutionPipeline` itself — the layer that decides *how* to
  route a request before it ever reaches the part that actually executes anything.
- **Phase 8 — Background runtime.** Added `BackgroundRuntime` and its always-on workers, plus
  `RuntimePolicyEngine` (quiet hours, cooldowns, rate limits) and the runtime
  diagnostics/reporting surface behind `/runtime *`.
- **Phases 9.1–9.8 — Autonomous planning (read-only).** A sequence of small, focused engines,
  each adding one more layer of judgment on top of the last: rank recommendations across every
  repository → detect chronic/escalating/flapping patterns → score readiness → sequence by
  priority → classify cadence. Deliberately built so that, at the end of this stretch, the
  system could compute "what should happen next" without being able to *do* anything about it.
- **Phase 10 (and 10.1–10.3) — Plan recording.** Added an explicit write path
  (`AutonomousPlanRecordingService`) and a worker that records one planning cycle to disk every
  hour, so the pattern detectors added in Phase 9 have real history to look back on.
- **Phase 11 — First execution capability.** `AutonomousExecutionOrchestrator` — the moment the
  previously read-only planning stack gained the ability to turn its top recommendation into a
  real request, but only for one specific, low-risk recommendation kind
  (`RepositoryReadyToShip`).
- **Phase 12 — Manual trigger.** Added `/auto-execute` so a human could invoke that same
  orchestrator on demand, before trusting it to run unattended.
- **Phase 13 — Unattended trigger.** Added `AutonomousExecutionWorker`, an hourly timer that
  calls the same orchestrator without any human pressing a button — the first genuinely
  autonomous (non-Telegram-triggered) execution path.
- **Phase 14 — Operator approval channel.** Added `telegram.operator_chat_id` so an
  autonomously-triggered approval-gated step (a push, say) has somewhere real to send its
  approval prompt, instead of being denied automatically for lacking a Telegram-shaped
  correlation id.
- **Phase 15 — Outcome notifications.** Added `NotifyingAutonomousExecutionOrchestrator`, which
  tells the operator what happened after every real autonomous attempt — closing the loop from
  "the system planned something" to "the system did something, and told me."

Each phase built strictly on what came before, and — this is deliberate — the *ability* to
execute autonomously (Phase 11) came only after nine phases of read-only planning had already
proven themselves. Nothing was allowed to act before it could first be observed.

## 6. Pre-release audit and v1.0.0

Before tagging a first real release, the project ran a manual audit pass and fixed three
concrete defects it found (`fix: close v1.0.0 release blockers found in the pre-release
audit`):

1. **An approval bypass** — if Telegram was disabled, the always-on autonomous execution worker
   could reach real git/GitHub operations without passing through the approval gate at all. The
   fix wires `ApprovalEngine` unconditionally, before the Telegram on/off check is even
   consulted.
2. **A crash risk** — a missing or misconfigured `claude` executable could crash the entire
   process via an unhandled Node event, instead of failing just the one workflow that needed it.
3. **A broken verification script** — one of the verification scripts had silently stopped
   working after an earlier phase changed a constructor signature underneath it.

With those closed, `v1.0.0` was tagged — the first semantic-version release, distinct from the
`phase-N-complete` development tags that came before it.

## 7. Production hardening

Separately from the phase work above, an operational-hardening pass added the tooling needed to
run this unattended, long-term, without a human watching a terminal:

- **`scripts/start.sh`** — checks Node version and that `dist/index.js` exists, then `exec`s the
  process so a supervisor's `SIGTERM` reaches it directly.
- **`EnvironmentValidator`** — runs once at boot, checks Node version, whether `git`/`claude`/
  `gh` actually resolve on `PATH`, and whether the memory directory is writable. Every check is
  advisory (logged, not fatal) — the project doesn't refuse to start over an optional
  prerequisite it might not need for a given deployment.
- **`HealthCheckWorker`** and **`scripts/health-check.ts`** — a file-based heartbeat
  (`health.json`, written every 60 seconds) and a script that reads it and reports healthy or
  not. No HTTP endpoint was added — the process has no inbound network port and there was no
  reason to open one just for health checks.
- **Graceful shutdown** — on `SIGINT`/`SIGTERM`, the process stops Telegram polling, stops the
  background workers, and arms a bounded force-exit timer so a stuck approval or a long-running
  Claude call can never hang the process indefinitely past shutdown.
- **`scripts/backup-memory.sh`** — a plain snapshot tool that tars up the memory directory
  (execution history and recorded plans) into a timestamped archive.
- **`ecosystem.config.js`** — the PM2 process definition used in the next step.

## 8. PM2 deployment

With hardening in place, the process was put under PM2 supervision as the permanent way to run
it in production (Stage 6, `chore(deploy): Stage 6 production deployment hardening and
verification`):

```bash
npm run build
npm run pm2:start   # pm2 start ecosystem.config.js
```

Two settings in `ecosystem.config.js` are correctness requirements, not preferences:
- **`instances: 1`, `exec_mode: "fork"`** — this process holds important state only in memory
  (active Claude sessions, pending Telegram approvals, rate-limit/cooldown state) and runs
  exactly one Telegram long-polling loop. PM2's default cluster mode would run several copies,
  each polling Telegram independently and fighting over the same update stream.
- **`watch: false`** — the process continuously writes its own history files. A file-watch
  restart policy pointed anywhere near that directory would create a restart loop.

`pm2` itself was added as a local dependency in this step, because a bare `pm2` on `PATH` wasn't
guaranteed to exist on a fresh checkout.

## 9. Validation

Two different kinds of validation happened, and both matter:

**Release validation** (`RELEASE.md`) — the checklist run before tagging `v1.0.0`: clean working
tree, a clean build, zero TypeScript errors, every verification script in `scripts/verify-*.ts`
passing, no leftover debug code, and all known release blockers confirmed closed. This is a
manual checklist, run by hand — there is no CI pipeline in this repository.

**Production verification** (`PRODUCTION_READY.md`) — after deploying under PM2, each claim was
checked against a real running instance, not just read from source: PM2 reported fork mode, one
instance, `online` status; a graceful restart went from `SIGTERM` to a fresh process in about 2
seconds; the health-check script reported healthy after the first tick; the backup script
produced a real, verified archive; both log files existed and contained exactly the expected
lines.

---

## What's done, and what's still manual

**Completed and verified against a real running process:**
- Core execution pipeline, approval gating, and the `/ship` workflow
- The full autonomous planning → execution → notification chain (Phases 9–15)
- Telegram command handling and the approval button flow
- PM2 process supervision, graceful restart, health checks, log capture, backup/restore path
- The pre-release audit fixes and the `v1.0.0` tag

**Still manual, by necessity rather than oversight:**
- **PM2 boot-persistence** (`pm2 startup` + `pm2 save`) — requires an interactive `sudo` prompt
  that the automated session couldn't supply (no terminal to type a password into). The exact
  commands are recorded in `PRODUCTION_CHECKLIST.md` for an operator to run once, by hand, from
  a real terminal. Until that's done, a full host reboot will **not** bring the process back on
  its own.
- **`pm2-logrotate`** is not installed — log files will grow unbounded until someone runs
  `pm2 install pm2-logrotate`.
- **No Dockerfile and no CI/CD pipeline** exist in this repository — building, testing, and
  deploying are all manual, documented processes today, not automated ones.
- **`npm run backup-memory` is not wired into cron** — it's a snapshot tool that has to be
  scheduled by an operator at whatever interval matches acceptable data loss.
- **`.env` backup** is explicitly the operator's responsibility — it holds the real bot token
  and is deliberately excluded from the automated memory backup.

This document does not describe any feature, command, or capability beyond what's in the
current codebase — see `TELEGRAM_COMMANDS.md` for the exact, current set of things you can ask
the bot to do, and `DEPLOYMENT.md`/`PRODUCTION_CHECKLIST.md` for the full operational detail
behind the summary above.
