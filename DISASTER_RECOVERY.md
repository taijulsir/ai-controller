# Disaster Recovery Checklist

> Stage 6 (Production Deployment) deliverable. Scenario-driven recovery runbook. For the
> narrative version of most of this (why each file matters, what's safe to lose), see
> [DEPLOYMENT.md](./DEPLOYMENT.md#recovery-procedures) — this file is the "something is broken
> right now, what do I do" version, organized by symptom.

## Severity guide

- **P1 — process down, not restarting**: Telegram unresponsive, PM2 shows `errored`/`stopped`.
- **P2 — degraded**: process is up but a specific capability is failing (health check stale,
  one integration erroring).
- **P3 — data risk, no immediate outage**: corrupted history file, stale backup, disk filling up.

## P1: Process is down and PM2 isn't bringing it back

1. Check PM2's own view first:
   ```bash
   npx pm2 list
   npx pm2 show ai-controller
   ```
   Look at `restarts` and `status`. If `restarts` has hit `max_restarts` (10) inside
   `min_uptime` (30s) windows, PM2 has given up — this means the process is crash-looping, not
   merely down.
2. Read the actual failure:
   ```bash
   tail -100 logs/ai-controller-error.log
   ```
   The most common causes, in order of likelihood:
   - **Bad `config/*.yaml`** — a `ConfigParseError`/`ConfigValidationError` naming the specific
     file and field. Fix the file, then `npx pm2 restart ai-controller`. There is no
     partial-start mode — do not try to patch around this by editing `dist/`.
   - **Missing `.env` / unset `TELEGRAM_BOT_TOKEN`** — fails at config-resolution time with a
     named "environment variable not set" error. Restore `.env` from your secrets store (see
     [P3: `.env` lost](#p3-env-lost-bot-token-unrecoverable-from-this-repo) below if there's no
     backup).
   - **`dist/` missing or stale** — `scripts/start.sh`'s own check (`Type=simple` under
     systemd) will refuse to start; under PM2 (`dist/index.js` invoked directly), this fails as
     a plain Node "module not found." Run `npm run build` and restart.
3. Once the root cause is fixed:
   ```bash
   npm run build             # if source changed
   npx pm2 restart ai-controller
   sleep 60
   npm run health-check      # confirm it's not just "started," but ticking
   ```
4. If PM2 itself is unresponsive (its own daemon, not the app):
   ```bash
   npx pm2 kill               # stops the PM2 daemon, not just the app
   npm run pm2:start
   ```
   Losing the PM2 daemon does **not** lose `ai-controller`'s own data — `memory/*.jsonl` and
   `health.json` are written by the app process itself, independent of PM2.

## P1: Host is gone entirely (disk loss, VM deleted, etc.)

Nothing in this application persists state outside the project directory and `memory.directory`
— there is no database to restore. Recovery is: provision a new host, then:

1. `git clone` this repository (or restore from your own git remote/mirror) at the last known
   good commit/tag (`vX.Y.Z` — see [RELEASE.md](./RELEASE.md)).
2. Restore `config/*.yaml` — these are version-controlled, so step 1 already recovers them,
   *unless* local-only overrides existed outside git; check for that first.
3. Restore `.env` from wherever it's backed up separately (see
   [P3: `.env` lost](#p3-env-lost-bot-token-unrecoverable-from-this-repo)) — it is
   deliberately not in git.
4. Restore the most recent `scripts/backup-memory.sh` archive (see
   [Restoring a memory backup](#restoring-a-memory-backup) below) — accept that anything since
   the last backup is lost; this only affects historical analysis quality (repeated-failure
   detection, plan-history pattern detectors), not correctness of a fresh start.
5. Follow [PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md) top to bottom as if this were a
   fresh install, including re-running the PM2 boot-persistence steps (`pm2 startup` +
   `pm2 save`) — these are host-local and do not survive a host swap even if they were
   previously configured on the old host.

## P2: Health check reports unhealthy but PM2 shows the process online

This means the process is alive but its event loop is stuck or `HealthCheckWorker`'s tick is
silently failing — a bare PID/status check from PM2 cannot distinguish "alive" from
"alive but wedged," which is exactly why the health-check script exists.

1. `tail -50 logs/ai-controller-out.log` — look for `health-check-worker: tick failed: ...`. A
   failed write is caught and logged but never stops the worker's timer, so a persistently
   stale heartbeat *without* a matching log line is itself the signal — it points at an
   event-loop stall, not a caught exception.
2. If genuinely wedged (no new log lines at all for several minutes), this is operationally a
   P1: `npx pm2 restart ai-controller`. In-memory session/approval state
   (`ClaudeSessionManager`, `TelegramApprovalProvider`) is lost on restart by design — nothing
   to manually reconcile, a fresh session starts on the next request.
3. If `memory.directory` itself became unwritable (disk full, permissions changed), fix that
   first — the same volume backs `events.jsonl`/`autonomous-plans.jsonl`, so a health-check
   failure here is often an early warning for those too.

## P3: `events.jsonl` or `autonomous-plans.jsonl` corrupted or truncated

Both are read line-by-line with per-line `JSON.parse`; there is no documented graceful-skip
behavior for a malformed line as of this writing (see
[DEPLOYMENT.md](./DEPLOYMENT.md#recovery-procedures)).

1. Stop the process first: `npx pm2 stop ai-controller` — do not hand-edit a file the app has
   open for continuous appends.
2. Prefer restoring the most recent `scripts/backup-memory.sh` archive over hand-repairing the
   file:
   ```bash
   npx pm2 stop ai-controller
   mv memory memory.broken-$(date -u +%Y%m%dT%H%M%SZ)
   tar -xzf backups/ai-controller-memory-<timestamp>.tar.gz -C .
   npx pm2 start ai-controller
   ```
3. If no backup exists newer than the corruption and the file must be salvaged: extract only
   the well-formed lines (`JSON.parse` each line in isolation, discard failures) into a new
   file before restarting — this is a manual, one-off script, not tooling this repo ships.
4. Neither file is required for the application to start — a missing file is treated as "no
   history yet." When in doubt, moving the broken file aside and letting the app start clean is
   always a safe fallback; the cost is lost history, not lost function.

## P3: `.env` lost (bot token unrecoverable from this repo)

`.env` is gitignored by design — it is never in git history to recover from. If there's no
separate encrypted backup:

1. Generate a new bot token from the Telegram side (BotFather — see
   [TELEGRAM.md](./TELEGRAM.md) for setup) if the old one is truly unrecoverable, since it
   cannot be regenerated from anything in this repository.
2. Write the new token into a fresh `.env` (copy `.env.example` for the shape).
3. `npx pm2 restart ai-controller` (or `pm2:start` if it wasn't running).
4. **Going forward**: back up `.env` separately and encrypted at rest — this is a standing gap
   noted in [DEPLOYMENT.md](./DEPLOYMENT.md#backup-guidance); `scripts/backup-memory.sh`
   deliberately never touches it.

## Restoring a memory backup

```bash
npx pm2 stop ai-controller
# BACK UP the current (possibly-fine) memory dir before overwriting, just in case:
mv memory memory.pre-restore-$(date -u +%Y%m%dT%H%M%SZ)
tar -xzf backups/ai-controller-memory-<timestamp>.tar.gz -C .
npx pm2 start ai-controller
sleep 60 && npm run health-check
```

There is no automated restore tooling today (noted as a known gap in
[DEPLOYMENT.md](./DEPLOYMENT.md#whats-not-included-yet)) — this is the full manual procedure.

## Post-incident

- [ ] Confirm `npm run health-check` is healthy.
- [ ] Confirm `npx pm2 show ai-controller` shows the expected `exec mode: fork_mode`, single
      instance, and a sane `restarts` count (a large jump is worth a follow-up look even after
      recovery, since `max_restarts`/`min_uptime` back off but don't reset without a fresh
      `pm2 start`).
- [ ] Take a fresh `npm run backup-memory` snapshot once things are stable, so the *next*
      incident has a more recent restore point.
- [ ] Record what happened somewhere durable (this repo has no built-in incident tracker — see
      [RELEASE.md](./RELEASE.md)'s note on the same gap for releases).
