// PM2 ecosystem configuration (Stage 4, operational hardening).
//
// Usage:
//   npm run build && pm2 start ecosystem.config.js
//   pm2 logs ai-controller
//   pm2 stop ai-controller
//
// See DEPLOYMENT.md for the full operational picture (environment variables,
// filesystem requirements, log rotation via pm2-logrotate, backups).
module.exports = {
  apps: [
    {
      name: "ai-controller",
      script: "dist/index.js",
      cwd: __dirname,

      // Correctness requirement, not a preference: this process holds
      // significant single-instance, in-memory state — ClaudeSessionManager's
      // session map, TelegramApprovalProvider's pending-approval map,
      // RuntimePolicyEngine's quiet-hours/cooldown state — and runs exactly
      // one Telegram long-polling loop. PM2's default cluster mode would run
      // multiple instances of this process, each independently polling
      // Telegram and racing on the same getUpdates offset, and each holding
      // its own disjoint copy of session/approval/policy state. Never change
      // this without first making those stores externally shared, which this
      // codebase does not do today.
      instances: 1,
      exec_mode: "fork",

      // Also a correctness requirement: this process writes to
      // memory/events.jsonl, memory/autonomous-plans.jsonl, and
      // memory/health.json on its own, continuously, as part of normal
      // operation. PM2's file-watch restart feature, if pointed at this
      // directory (or the project root without excludes), would restart the
      // process every time it writes its own history — a restart loop, not
      // a development convenience. Leave this false; use `pm2 restart` /
      // `pm2 reload` explicitly for actual code deploys instead.
      watch: false,

      // See src/index.ts's shutdown() handler: it stops the Telegram
      // long-poller and the background runtime, then bounds the whole
      // shutdown to SHUTDOWN_TIMEOUT_MS (default 10s, overridable via the
      // env var below) before forcing its own exit. kill_timeout must stay
      // comfortably above that bound so PM2's own SIGKILL never preempts our
      // controlled, logged shutdown — 15s here, 10s there, a 5s margin.
      kill_timeout: 15_000,

      // Crash-loop protection: don't restart forever at full speed if the
      // process is failing immediately on every start (e.g. a bad config
      // change) — back off and eventually stop trying, rather than hammering
      // the Telegram API or an unreachable git remote in a tight loop.
      autorestart: true,
      max_restarts: 10,
      min_uptime: "30s",
      restart_delay: 2_000,
      exp_backoff_restart_delay: 200,

      env: {
        NODE_ENV: "production",
        // SHUTDOWN_TIMEOUT_MS: "10000",   // uncomment to override the default
      },

      // stdout/stderr only — see DEPLOYMENT.md's "Logging" section: this
      // process does not write its own log files (config/controller.yaml's
      // logging.* fields are validated but not wired to file output), so
      // these PM2-managed files are the only durable log capture available
      // today. Install pm2-logrotate (`pm2 install pm2-logrotate`) to bound
      // their growth — PM2 does not rotate these on its own.
      error_file: "logs/ai-controller-error.log",
      out_file: "logs/ai-controller-out.log",
      merge_logs: true,
      time: true,
    },
  ],
};
