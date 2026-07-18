// Operational health-check tool (Stage 4) — NOT part of the scripts/verify-*.ts
// test suite and not run by DEVELOPMENT.md's "run every verification
// script" loop. Reads the heartbeat file HealthCheckWorker writes
// (src/runtime/HealthCheckWorker.ts) and exits 0 if it's fresh, 1 otherwise
// — usable manually, from a cron job, or as an external check hook from a
// process supervisor. Intentionally has no network dependency: this process
// has no HTTP server, so "health" here means "the heartbeat file is being
// refreshed," not "an HTTP endpoint responded."
//
// Usage: npx tsx scripts/health-check.ts
// Exit code 0: healthy. Exit code 1: unhealthy or unknown (prints why to stderr).

import { readFileSync } from "node:fs";
import path from "node:path";
import { ConfigService } from "../src/config/ConfigService";

// Generously wider than HealthCheckWorker's own default 60s tick interval,
// so one slow/skipped tick (e.g. a re-entrancy-guarded overlap) doesn't
// produce a false "unhealthy" — three missed ticks in a row is a much
// stronger signal than one.
const STALENESS_MULTIPLIER = 3;
const DEFAULT_INTERVAL_MS = 60 * 1000;

function fail(message: string): never {
  console.error(`UNHEALTHY: ${message}`);
  process.exit(1);
}

function main(): void {
  const configService = new ConfigService();

  let memoryDirectory: string;
  try {
    memoryDirectory = configService.getControllerConfig().memory.directory;
  } catch (error) {
    fail(`could not read config/controller.yaml: ${error instanceof Error ? error.message : String(error)}`);
  }

  const healthFilePath = path.join(memoryDirectory, "health.json");

  let raw: string;
  try {
    raw = readFileSync(healthFilePath, "utf8");
  } catch (error) {
    fail(
      `could not read "${healthFilePath}" — either the process has never started, is still on its first tick (up to ${DEFAULT_INTERVAL_MS / 1000}s after startup), or memory.directory is misconfigured: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let heartbeat: { status?: string; pid?: number; uptimeSeconds?: number; writtenAt?: string };
  try {
    heartbeat = JSON.parse(raw);
  } catch (error) {
    fail(`"${healthFilePath}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (typeof heartbeat.writtenAt !== "string") {
    fail(`"${healthFilePath}" is missing a writtenAt timestamp`);
  }

  const writtenAtMs = Date.parse(heartbeat.writtenAt);
  if (Number.isNaN(writtenAtMs)) {
    fail(`"${healthFilePath}" has an unparseable writtenAt value: "${heartbeat.writtenAt}"`);
  }

  const ageMs = Date.now() - writtenAtMs;
  const stalenessThresholdMs = DEFAULT_INTERVAL_MS * STALENESS_MULTIPLIER;
  if (ageMs > stalenessThresholdMs) {
    fail(
      `heartbeat is stale — last written ${Math.round(ageMs / 1000)}s ago, exceeding the ${stalenessThresholdMs / 1000}s threshold. The process is likely stuck or has stopped (pid ${heartbeat.pid ?? "unknown"}).`,
    );
  }

  console.log(
    `HEALTHY: pid ${heartbeat.pid}, uptime ${heartbeat.uptimeSeconds}s, heartbeat ${Math.round(ageMs / 1000)}s old.`,
  );
  process.exit(0);
}

main();
