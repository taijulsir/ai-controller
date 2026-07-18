# Deployment

> **Scope note**: this document describes deploying the application *as it exists today*,
> including the Stage 4 operational-hardening tooling (PM2 ecosystem config, startup
> validation, health checks, backup script). What's still genuinely absent is listed in
> [What's not included yet](#whats-not-included-yet) — updated in place rather than duplicated
> into a new file each time something is added.

## What the application actually is, operationally

A single long-running Node.js process (`node dist/index.js`) that:
- polls the Telegram Bot API in a loop (if `telegram.enabled: true`) — no inbound network port
  is opened, so there is nothing to reverse-proxy or expose publicly
- runs four background timers unconditionally (`MonitoringWorker` every 15 min,
  `AutonomousPlanRecordingWorker` and `AutonomousExecutionWorker` every hour, `HealthCheckWorker`
  every minute) — these run even if Telegram is disabled
- shells out to `git`, `claude`, and `gh` CLIs as needed against repositories on local disk
- writes three files under `memory.directory`: two append-only JSONL logs (`events.jsonl`,
  `autonomous-plans.jsonl`) and one small heartbeat file (`health.json`, overwritten every
  minute) — nothing else touches disk at runtime besides reading `config/*.yaml`

There is still no HTTP server and no database — the health-check mechanism (below) is
file-based, deliberately, rather than adding a network port.

## Building and running

```bash
npm install
npm run build          # tsc -> dist/
cp .env.example .env    # fill in TELEGRAM_BOT_TOKEN
npm run start:checked   # scripts/start.sh — validates Node version and dist/ before starting
# or, equivalently, without the shell-level pre-checks:
npm start
```

See [CONFIGURATION.md](./CONFIGURATION.md) for the full set of required `config/*.yaml` files
and environment variables that must be present before the process will start — a missing file,
malformed YAML, or unset `${VAR}` reference all fail startup immediately with a specific error
(see [CONFIGURATION.md](./CONFIGURATION.md#typed-error-classes-srcconfigerrorsts)).

## Environment validation

In addition to `ConfigService`'s own fail-fast config validation (unchanged, still fatal on a
bad config file), `src/index.ts` now runs `EnvironmentValidator` once at the very start of
`bootstrap()`, before anything else is constructed. It checks: the running Node version against
this project's stated minimum (20.6+), whether `git`/the configured `claude` executable/the
configured `gh` executable actually resolve on `PATH`, and whether `memory.directory` can be
created and is writable. **Every check is advisory** — findings are logged as
`environment-validator: [<check>] <message>` and startup continues regardless, since `claude`/
`gh` are only required for specific workflows (per README.md), not universally, and this project
doesn't gate startup on an optional prerequisite that might never be needed in a given
deployment. Treat a logged warning as something to fix before relying on the affected
capability, not as a startup failure to chase.

## Health checks

`HealthCheckWorker` (one of `BackgroundRuntime`'s four workers) writes `memory.directory/health.json`
every 60 seconds: `{status, pid, uptimeSeconds, writtenAt}`. `scripts/health-check.ts` reads it
and exits 0 if the heartbeat is fresh (within 3x the write interval, i.e. tolerant of one missed
tick) or 1 otherwise, printing why:

```bash
npm run health-check
```

This is a file-based liveness check, not an HTTP endpoint — appropriate for a process with no
inbound network port, and avoids adding one just to answer health checks. Use it:
- **Manually** — to confirm a running instance is actually still ticking, not just that its PID
  exists.
- **From cron or an external monitor** — schedule it and alert on non-zero exit.
- **As a PM2 external check** — PM2 itself already restarts a crashed process (see
  [Process supervision](#process-supervision-pm2) below); this script is for verifying the
  process is alive *and responsive*, which a bare PID check can't distinguish from "alive but
  wedged."

There is no health data before the first tick completes (up to 60s after startup) — expect
`scripts/health-check.ts` to report unhealthy during that window; this is expected, not a bug.

## Filesystem requirements

The process needs read access to `config/*.yaml`, and write access to:
- `memory.directory` (`config/controller.yaml`) — must exist or be creatable; written to by
  `ProjectMemoryService`, `AutonomousPlanHistoryService`, and now `HealthCheckWorker`
- every repository's `path` (`config/repositories.yaml`) — needs whatever access level the
  configured `git`/`claude`/`gh` CLIs need to operate on it (working tree writes, commits,
  pushes to its configured remote)

`workspace.root` (`config/controller.yaml`) is validated as a string but not currently used by
any path-resolution logic — repository paths come directly from `config/repositories.yaml`.

## Graceful shutdown

`src/index.ts`'s `SIGINT`/`SIGTERM` handler:
1. Stops the Telegram long-poller, if running — aborts any in-flight long-poll HTTP request
   immediately rather than waiting for it to time out.
2. Stops `BackgroundRuntime` — stops all four workers, each with independent error isolation.
3. **Arms a bounded force-exit** (Stage 4 hardening): without this, a pending Telegram approval
   (`TelegramApprovalProvider`'s own timeout, up to 15 minutes) or an in-flight Claude call
   (`ClaudeAdapter`'s own execution timeout, up to `ClaudeConfig.execution.max_execution_minutes`)
   can each independently keep the process alive well past steps 1-2, since neither timer is
   touched by shutdown. A `SHUTDOWN_TIMEOUT_MS`-bounded timer (default 10000ms, overridable via
   that environment variable) forces `process.exit(1)` with a clear log line if reached. In the
   common case — nothing pending — this adds **zero delay**: the timer is `unref()`'d, so a
   clean shutdown exits exactly as fast as it did before this was added. Verified directly: a
   live run with nothing in flight went from `SIGTERM received` to process exit in under a
   second.

If your process supervisor has its own kill timeout (PM2's `kill_timeout`, systemd's
`TimeoutStopSec`), keep it comfortably above `SHUTDOWN_TIMEOUT_MS` so this process's own
controlled shutdown always gets a chance to run first — `ecosystem.config.js` sets
`kill_timeout: 15000` for exactly this reason.

## Logging

All current logging goes to **stdout/stderr only** — either raw `console.log`/`console.error`
calls (most of the codebase) or `src/telegram/`'s structured `logEvent()` helper (also written
to stdout). `config/controller.yaml`'s `logging.enabled`/`logging.level`/`logging.directory`
fields are validated on load but **still not consulted by any logging call site** — no file is
written to `logging.directory`, regardless of its value. `ecosystem.config.js` captures
stdout/stderr to `logs/ai-controller-out.log`/`logs/ai-controller-error.log` when run under PM2
— install `pm2-logrotate` (`pm2 install pm2-logrotate`) to bound their growth, since PM2 does
not rotate these on its own. Running without PM2: redirect output yourself and rotate with
`logrotate`, or rely on `journald`'s own rotation under systemd.

## Environment variables and secrets

`TELEGRAM_BOT_TOKEN` (see `.env.example`) is the only environment variable this project
requires for its own configuration, resolved via `config/telegram.yaml`'s
`${TELEGRAM_BOT_TOKEN}` placeholder. `SHUTDOWN_TIMEOUT_MS` (optional, see
[Graceful shutdown](#graceful-shutdown)) is the only other environment variable the process
reads. `.env` is gitignored — never commit real secrets into `config/*.yaml` directly; use the
`${VAR}` placeholder syntax for any future secret the same way.

## Process supervision (PM2)

```bash
npm run build
npm run pm2:start   # pm2 start ecosystem.config.js
npm run pm2:logs
npm run pm2:stop
```

`ecosystem.config.js` (repository root) is annotated in place with the reasoning behind each
non-default setting — two are correctness requirements, not preferences, worth restating here:
- **`instances: 1`, `exec_mode: "fork"`** — this process holds significant single-instance,
  in-memory state (`ClaudeSessionManager`'s session map, `TelegramApprovalProvider`'s
  pending-approval map, `RuntimePolicyEngine`'s cooldown/quiet-hours state) and runs exactly one
  Telegram long-polling loop. PM2's default cluster mode would run multiple instances, each
  independently polling Telegram and racing on the same update offset. Do not change this
  without first externalizing those stores, which this codebase does not do.
- **`watch: false`** — this process continuously writes its own files under `memory.directory`
  (`events.jsonl`, `autonomous-plans.jsonl`, `health.json`). PM2's file-watch restart feature,
  if pointed anywhere near that directory, would restart the process every time it writes its
  own history — a restart loop.

## Process supervision (systemd)

```ini
[Unit]
Description=AI Controller
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/ai-controller
ExecStart=/path/to/ai-controller/scripts/start.sh
Restart=on-failure
TimeoutStopSec=20
EnvironmentFile=/path/to/ai-controller/.env

[Install]
WantedBy=multi-user.target
```

`scripts/start.sh` performs the shell-level checks that make sense to fail on before Node even
starts (Node version present and new enough, `dist/index.js` exists) and then `exec`s
`node dist/index.js` — using `exec` rather than a plain invocation is what lets systemd's
`SIGTERM` reach the actual Node process directly, which is required for the graceful-shutdown
handler above to ever receive it. `TimeoutStopSec` should stay above `SHUTDOWN_TIMEOUT_MS`, same
reasoning as PM2's `kill_timeout`.

## Backup guidance

```bash
npm run backup-memory                    # writes to ./backups/ by default
npm run backup-memory -- /path/to/dest   # or an explicit destination
```

`scripts/backup-memory.sh` tars `memory.directory` (read from `config/controller.yaml` the same
way the application itself reads it, not a hardcoded path) into a timestamped archive. This is
a plain snapshot tool, not a scheduled job — wire it into cron or your platform's own backup
scheduler at whatever interval matches how much history you'd mind losing.

Two files matter for continuity:
- `events.jsonl` — execution history; loss means `DecisionEngine`'s repeated-failure detection
  and `/history` lose prior context, but does not affect current repository state.
- `autonomous-plans.jsonl` — recorded planning cycles; loss means the "chronic"/"sustained
  escalation"/"flapping" pattern detectors in `AutonomousPlanningAnalysisEngine` restart from
  zero history, but the *live* plan (recomputed from current repository state on every call)
  is unaffected.

Neither file (nor `health.json`) is required for the application to start — a missing file is
treated as "no history yet," not an error.

`config/*.yaml` should be backed up/version-controlled like any other configuration — `.env`
should be backed up separately and encrypted at rest, since it holds the bot token. Neither is
covered by `scripts/backup-memory.sh`, which only touches `memory.directory`.

## Recovery procedures

- **Process crashed / needs restart**: simply restart it — `ClaudeSessionManager`'s in-memory
  session state and `TelegramApprovalProvider`'s in-memory pending-approval state are both
  lost on restart by design (see [SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md) and
  [TELEGRAM.md](./TELEGRAM.md#approval-flow)); nothing needs manual repair — a fresh session
  starts on the next Claude-backed request, and any approval that was mid-flight simply never
  resolves for its original caller. Under PM2, this restart is automatic
  (`autorestart: true`, with `max_restarts`/`min_uptime` guarding against a crash loop); run
  `npm run health-check` after a restart to confirm the new process is actually ticking, not
  just that PM2 believes it started.
- **Corrupt `config/*.yaml`**: the process refuses to start with a specific
  `ConfigParseError`/`ConfigValidationError` naming the file and the problem — fix the file and
  restart; there's no partial-start mode.
- **`events.jsonl` or `autonomous-plans.jsonl` corrupted/truncated**: both are read
  line-by-line with per-line `JSON.parse`; a malformed line does not currently have documented
  graceful-skip behavior confirmed in this pass — treat a corrupted history file as a
  known-risk area and prefer restoring from a `scripts/backup-memory.sh` snapshot over
  hand-editing it.
- **`health.json` looks stale but the process seems otherwise fine**: check
  `HealthCheckWorker`'s own tick failures aren't silently accumulating — a failed write is
  caught and logged (`health-check-worker: tick failed: ...`) but never stops the worker's
  timer, so a persistently stale heartbeat with no matching log line would itself be worth
  investigating as an event-loop stall.

## What's not included yet

- No Dockerfile / container image
- No CI/CD pipeline (no `.github/workflows` or equivalent in this repository)
- No automated restore tooling for `scripts/backup-memory.sh`'s archives (restoring today means
  extracting the tarball over `memory.directory` by hand while the process is stopped)
- No log rotation for a self-written application log file, because none exists — see
  [Logging](#logging); rotation is delegated entirely to whatever runs the process

See [RELEASE.md](./RELEASE.md) for how a release is currently validated by hand in the
absence of CI.
