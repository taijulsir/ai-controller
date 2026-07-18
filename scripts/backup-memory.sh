#!/usr/bin/env bash
# Backs up the Project Memory directory (Stage 4, operational hardening).
# See DEPLOYMENT.md's "Backup guidance" section for what these files are and
# why they matter (execution history, autonomous plan history) — neither is
# required for the application to start; a missing file is treated as "no
# history yet," not an error, so this backup is about continuity of
# analysis/insight quality, not application availability.
#
# This is a plain tar snapshot, not a scheduled job — wire it into cron or
# your platform's own backup scheduler at whatever interval matches how much
# history you'd mind losing. It does not touch config/*.yaml or .env; back
# those up separately (see DEPLOYMENT.md).
#
# Usage:
#   scripts/backup-memory.sh [destination-directory]
#   destination-directory defaults to ./backups relative to the project root.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="${1:-$PROJECT_ROOT/backups}"

# Reads memory.directory the same way the application itself does — via
# ConfigService, not a hardcoded path — so this script stays correct if that
# setting is ever changed in config/controller.yaml.
MEMORY_DIR="$(cd "$PROJECT_ROOT" && npx tsx -e '
import { ConfigService } from "./src/config/ConfigService";
console.log(new ConfigService().getControllerConfig().memory.directory);
')"

if [ ! -d "$MEMORY_DIR" ]; then
  echo "backup-memory.sh: memory directory \"$MEMORY_DIR\" does not exist yet — nothing to back up." >&2
  exit 0
fi

mkdir -p "$DEST_DIR"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE_PATH="$DEST_DIR/ai-controller-memory-${TIMESTAMP}.tar.gz"

tar -czf "$ARCHIVE_PATH" -C "$(dirname "$MEMORY_DIR")" "$(basename "$MEMORY_DIR")"

echo "backup-memory.sh: wrote $ARCHIVE_PATH"
