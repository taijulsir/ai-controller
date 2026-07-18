# Production Deployment Checklist

> Stage 6 (Production Deployment) deliverable. This is the operational runbook for taking a
> built copy of this repository from "code on disk" to "supervised, restart-safe, monitored
> production process." It assumes [DEPLOYMENT.md](./DEPLOYMENT.md) has already been read once —
> this file is the checklist form of it, in the order to actually execute.

## Before every deploy (fresh install or redeploy)

- [ ] `git status` — working tree clean, only the intended commit(s) present.
- [ ] `npm install` — installs runtime deps and `pm2` (now a devDependency; see
      [What changed in Stage 6](#what-changed-in-stage-6)).
- [ ] `npm run build` — must complete with zero `tsc` errors.
- [ ] `npx tsc --noEmit` — zero type errors (does not cover `scripts/*.ts`; see
      [DEVELOPMENT.md](./DEVELOPMENT.md#type-checking)).
- [ ] `.env` exists at the project root with a real `TELEGRAM_BOT_TOKEN` (`.env` is gitignored —
      never committed; copy from `.env.example` and fill in).
- [ ] `config/*.yaml` present and valid — a missing file or bad `${VAR}` reference fails startup
      immediately with a named error (see [CONFIGURATION.md](./CONFIGURATION.md)).
- [ ] `config/controller.yaml`'s `memory.directory` and `logging.directory` paths are writable
      by the user that will run the process.

## Starting under PM2 (the supervised path — use this in production)

```bash
npm run build
npm run pm2:start        # pm2 start ecosystem.config.js
```

- [ ] `npx pm2 show ai-controller` reports `exec mode: fork_mode` and a single instance —
      **never** switch this to cluster mode; see the correctness note at the top of
      `ecosystem.config.js`.
- [ ] `npx pm2 list` shows `status: online` and `restarts: 0` immediately after start (a nonzero
      restart count on a fresh start means it crashed and PM2's `autorestart` already kicked in
      — check `logs/ai-controller-error.log` before proceeding).
- [ ] `logs/ai-controller-out.log` shows the expected startup lines: `"<name> vX.Y.Z started."`,
      `"Registered repositories: ..."`, and (if Telegram is enabled)
      `"Telegram transport enabled, starting long polling."` / `telegram.polling.started`.
- [ ] `logs/ai-controller-error.log` is empty.

## Health verification

- [ ] Wait up to 60s for the first `HealthCheckWorker` tick, then run:
      ```bash
      npm run health-check
      ```
      Must print `HEALTHY: pid <pid>, uptime <n>s, heartbeat <n>s old.` and exit 0. An
      `UNHEALTHY` result inside the first 60s is expected — see
      [DEPLOYMENT.md](./DEPLOYMENT.md#health-checks); re-run after the first tick completes.
- [ ] Confirm the `pid` in the health-check output matches PM2's reported pid
      (`npx pm2 show ai-controller`).

## Graceful restart verification

```bash
npx pm2 restart ai-controller
```

- [ ] `logs/ai-controller-out.log` shows, in order: `"SIGINT received — shutting down (up to
      <SHUTDOWN_TIMEOUT_MS>ms grace period)..."`, `telegram.polling.stopped`, then a fresh
      `"... started."` line — all within a few seconds, well under `kill_timeout` (15s).
- [ ] `npx pm2 show ai-controller` shows the restart counter incremented by exactly 1 and a new
      pid.
- [ ] Re-run `npm run health-check` (after another ~60s) to confirm the new process is actually
      ticking, not just that PM2 believes it started.

## Boot persistence (survive a host reboot)

PM2 does not survive a reboot on its own — it needs a one-time systemd registration plus a
process-list snapshot. **Both steps require an interactive `sudo` prompt and cannot be run
through an unattended/non-TTY session** (confirmed in this deployment: `pm2 startup` demands a
password and there is no askpass helper configured). Run these yourself, once, from a real
terminal on the host:

```bash
# 1. Registers a systemd service that starts the PM2 daemon on boot.
#    pm2 prints the exact command for this host/user — run the command it prints,
#    which will look like:
sudo env PATH=$PATH:<node-bin-dir> <project-root>/node_modules/pm2/bin/pm2 startup systemd -u <user> --hp <home-dir>

# 2. Snapshot the currently-running process list so PM2 knows what to resurrect on boot.
npx pm2 save
```

- [ ] `sudo systemctl status pm2-<user>` shows the generated service `enabled` and `active`.
- [ ] `~/.pm2/dump.pm2` exists and was updated (`pm2 save`'s snapshot file).
- [ ] (Optional, destructive-adjacent — confirm before doing this on a live host) reboot the
      host and confirm `pm2 list` shows `ai-controller` back online afterward.

**Status as of this deployment: steps above are documented but not yet executed** — see
[PRODUCTION_READY.md](./PRODUCTION_READY.md#open-items) for why and who owns finishing it.

## Log locations

| What | Path | Rotated by |
|---|---|---|
| stdout | `logs/ai-controller-out.log` | nothing yet — install `pm2 install pm2-logrotate` |
| stderr | `logs/ai-controller-error.log` | nothing yet — same as above |
| PM2 daemon's own logs | `~/.pm2/pm2.log`, `~/.pm2/logs/` | PM2 itself |

- [ ] `pm2 install pm2-logrotate` if this deployment is expected to run for weeks without a
      manual log check — PM2 does not rotate `error_file`/`out_file` on its own (noted in
      `ecosystem.config.js` and [DEPLOYMENT.md](./DEPLOYMENT.md#logging)).

## Backup workflow

```bash
npm run backup-memory                    # writes to ./backups/<timestamp>.tar.gz
```

- [ ] Archive contains `memory/events.jsonl`, `memory/autonomous-plans.jsonl`, and
      `memory/health.json` (verified in this deployment — see
      [PRODUCTION_READY.md](./PRODUCTION_READY.md)).
- [ ] `config/*.yaml` is backed up separately (it's version-controlled, so `git` history already
      covers it) — `scripts/backup-memory.sh` deliberately does not touch it.
- [ ] `.env` is backed up separately and encrypted at rest — never inside the memory tarball,
      never committed.
- [ ] Wire `npm run backup-memory` into cron (or the platform's own scheduler) at whatever
      interval matches acceptable history loss — this script is a snapshot tool, not a
      scheduled job by itself.

## What changed in Stage 6

- Added `pm2` as a local `devDependency` (`package.json`, `package-lock.json`). Previously
  `npm run pm2:start`/`pm2:stop`/`pm2:logs` invoked a bare `pm2` that did not resolve on `PATH`
  in a fresh environment; installing it locally makes it resolve via `node_modules/.bin`, which
  `npm run` puts on `PATH` automatically — no script content changed.
- `config/controller.yaml`: `controller.environment` changed from `development` to `production`.
  This field is validated as a string but not consumed by any runtime logic (confirmed by
  reading `src/config/validators.ts` and searching all call sites) — it's a descriptive label,
  now corrected to match reality now that this process is under permanent PM2 supervision.

No business logic, architecture, or feature changes were made in this stage.
