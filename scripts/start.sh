#!/usr/bin/env bash
# Startup wrapper for manual or systemd use (Stage 4, operational hardening).
# PM2 (ecosystem.config.js) invokes dist/index.js directly and does not use
# this script — PM2 already owns process supervision/restart policy itself.
#
# This script's job is the handful of checks that make sense to fail on
# *before* a Node process even starts, at the shell level — the same spirit
# as src/startup/EnvironmentValidator.ts's in-process checks, but for things
# that need to be caught even earlier. It changes nothing about the
# application itself.
#
# Usage: scripts/start.sh
# systemd ExecStart example: see DEPLOYMENT.md.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

MIN_NODE_MAJOR=20
MIN_NODE_MINOR=6

if ! command -v node >/dev/null 2>&1; then
  echo "start.sh: 'node' was not found on PATH. This project requires Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+." >&2
  exit 1
fi

NODE_VERSION="$(node --version)"
NODE_MAJOR="$(echo "$NODE_VERSION" | sed -E 's/^v([0-9]+)\..*/\1/')"
NODE_MINOR="$(echo "$NODE_VERSION" | sed -E 's/^v[0-9]+\.([0-9]+)\..*/\1/')"

if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] || { [ "$NODE_MAJOR" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$MIN_NODE_MINOR" ]; }; then
  echo "start.sh: Node ${NODE_VERSION} found, but this project requires ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ (uses the built-in fetch API and process.loadEnvFile)." >&2
  exit 1
fi

if [ ! -f "$PROJECT_ROOT/dist/index.js" ]; then
  echo "start.sh: $PROJECT_ROOT/dist/index.js does not exist — run 'npm run build' first." >&2
  exit 1
fi

# exec, not a plain invocation: replaces this shell process with node rather
# than running node as a child of it, so SIGTERM/SIGINT from a process
# supervisor (systemd, docker stop, ...) reaches the actual Node process
# directly — required for src/index.ts's own graceful-shutdown handler to
# ever receive the signal it's listening for.
exec node "$PROJECT_ROOT/dist/index.js"
