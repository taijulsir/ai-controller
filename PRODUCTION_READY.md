# Production Ready Report — Stage 6 (Production Deployment)

> Final deliverable of the Release 1.0 roadmap. Stages 1–5 (Code Freeze, Architecture Audit,
> Documentation, Operational Hardening, Release Validation) are complete and are not re-litigated
> here. This report covers only Stage 6: taking the validated `v1.0.0` codebase and verifying it
> as a permanently-running production deployment.

## Scope discipline

No business logic, features, or architecture changed in this stage. The only two files touched
outside of new documentation:
- `package.json` / `package-lock.json` — `pm2` added as a `devDependency`.
- `config/controller.yaml` — `controller.environment: development` → `production` (a validated
  but functionally-inert descriptive label; confirmed by reading `src/config/validators.ts` and
  grepping all call sites — nothing branches on this value).

## What was verified, with evidence

### Build and type-check
```
npm run build   →  tsc, zero errors
```

### PM2 process supervision
- `pm2` was not previously installed anywhere resolvable on `PATH` (`which pm2` → not found;
  `npm run pm2:start` would have failed on a fresh checkout). Installed locally as a
  `devDependency` so `npm run pm2:start`/`pm2:stop`/`pm2:logs` resolve it via
  `node_modules/.bin` — no change to the scripts themselves or to `ecosystem.config.js`.
- Started under PM2: `npx pm2 show ai-controller` confirmed `exec mode: fork_mode`, a single
  instance, `status: online` — matching the correctness requirements documented inline in
  `ecosystem.config.js` (single in-memory session/approval/policy state, one Telegram
  long-polling loop; cluster mode would race multiple pollers on the same update offset).
- `logs/` did not exist before first start; PM2 created it automatically on `pm2 start`, as
  expected from `error_file`/`out_file` pointing there.

### Startup script (`scripts/start.sh`)
Read and confirmed it performs Node-version and `dist/index.js` presence checks, then `exec`s
`node dist/index.js` (not a plain invocation) — required so a supervisor's `SIGTERM` reaches the
Node process directly for the graceful-shutdown handler to receive it. PM2 does not use this
script (it invokes `dist/index.js` directly and owns supervision itself); it's for the
documented systemd path.

### Graceful restart
`npx pm2 restart ai-controller`, observed in `logs/ai-controller-out.log`:
```
18:06:33  SIGINT received — shutting down (up to 10000ms grace period)...
18:06:33  telegram.polling.stopped
18:06:35  <name> started.
18:06:35  Registered repositories: ...
18:06:35  telegram.polling.started
```
Full stop-to-start cycle completed in ~2 seconds, well inside the 10s shutdown timeout and the
15s PM2 `kill_timeout` margin `ecosystem.config.js` reserves for it. Restart counter incremented
by exactly 1 each time, pid changed each time — confirms PM2 is actually cycling the process,
not just reporting stale state.

### Health-check workflow
```
npm run health-check   →   HEALTHY: pid 228529, uptime 61s, heartbeat 36s old.
```
Verified against a real running instance after waiting for the first `HealthCheckWorker` tick
(up to 60s, as documented). Re-verified after each restart.

### Log locations
| Path | Verified contents |
|---|---|
| `logs/ai-controller-out.log` | Startup lines, `telegram.polling.started/stopped`, `SIGINT received` — as documented |
| `logs/ai-controller-error.log` | Empty — no errors during verification |

`pm2-logrotate` is **not yet installed** — flagged in both `ecosystem.config.js` and
`DEPLOYMENT.md` already; carried forward as an open item below, not silently dropped.

### Backup workflow
```
npm run backup-memory   →   wrote backups/ai-controller-memory-20260718T175914Z.tar.gz
```
Archive contents confirmed via `tar -tzf`: `memory/`, `memory/events.jsonl`,
`memory/autonomous-plans.jsonl`, `memory/health.json` — matches what `DEPLOYMENT.md` documents
as the backup's scope (excludes `config/*.yaml` and `.env` by design).

### `ecosystem.config.js`
Read in full. All non-default settings (`instances: 1`, `exec_mode: fork`, `watch: false`,
`kill_timeout: 15000`, `autorestart`/`max_restarts`/`min_uptime`/backoff, log file paths) are
already annotated in place with the correctness reasoning behind each, and every one of them was
exercised and matched observed behavior during this verification pass. No changes needed.

## Open items (not resolved in this stage — by necessity, not oversight)

1. **PM2 boot-persistence (`pm2 startup` + `pm2 save`) is documented but not executed.**
   `pm2 startup` requires an interactive `sudo` prompt; this session's shell has no TTY, so
   sudo cannot read a password through it under any invocation — confirmed directly (`sudo -n
   true` reports a password is required; attempting the generated `pm2 startup systemd ...`
   command itself fails with `sudo: a terminal is required to read the password`). This is a
   host/session constraint, not a configuration gap: the exact commands are recorded in
   [PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md#boot-persistence-survive-a-host-reboot)
   for the operator to run once from a real terminal on the host. Until that's done, a full
   host reboot will **not** bring `ai-controller` back automatically — a manual `npm run
   pm2:start` would be needed after any reboot in the meantime.
2. **`pm2-logrotate` not installed** — pre-existing gap, documented in `DEPLOYMENT.md` and
   `ecosystem.config.js` before this stage; still open. `pm2 install pm2-logrotate` is the fix,
   whenever this deployment is expected to run long enough for log growth to matter.
3. **No Dockerfile, no CI/CD** — pre-existing, unchanged scope from `DEPLOYMENT.md`'s own "What's
   not included yet" section; Stage 6 did not add these and wasn't asked to.

None of these block the process from running correctly today under PM2 with `autorestart`; they
specifically affect *reboot* survival and long-run log hygiene, not day-to-day operation.

## Live status at time of writing

The process is currently running under PM2 with the real, configured Telegram bot token —
this is the intended end state for "permanent production operation," not a leftover
verification artifact. `npx pm2 list` / `npm run health-check` reflect current live status at
any time; this report is a point-in-time snapshot of the verification pass, not a promise that
these exact pids/timestamps persist.

## Sign-off

Stage 6 tasks are complete except for the one item that structurally cannot be completed from
this session (boot-persistence registration, blocked on an interactive `sudo` prompt with no
TTY available) — tracked as an explicit, owned follow-up rather than silently skipped. Everything
else — PM2 supervision, graceful restart, health checks, log capture, backup/restore path — was
exercised against a real running instance, not just read from source, and matched documented
behavior.

**Recommendation: proceed to commit.** Tagging `v1.0.1` is a separate, explicit decision per
`RELEASE.md`'s own tagging policy — not taken automatically here.
