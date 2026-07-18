import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IConfigService } from "../src/config/interfaces";
import type {
  ClaudeConfig,
  ControllerConfig,
  GithubConfig,
  TelegramConfig,
} from "../src/config/types";
import type { Repository } from "../src/domain/repository/Repository";
import { HealthCheckWorker } from "../src/runtime/HealthCheckWorker";

class FakeConfigService implements IConfigService {
  constructor(private readonly memoryDirectory: string) {}

  getControllerConfig(): ControllerConfig {
    return {
      controller: { name: "test", version: "0.0.0", environment: "test" },
      workspace: { root: "/tmp" },
      task: { max_concurrent_jobs: 1, timeout_minutes: 5 },
      approval: { mode: "manual", require_before_git_push: true, require_before_pull_request: false },
      logging: { enabled: false, level: "info", directory: "/tmp" },
      memory: { enabled: true, directory: this.memoryDirectory },
    };
  }
  getClaudeConfig(): ClaudeConfig {
    throw new Error("not used in this verification script");
  }
  getGithubConfig(): GithubConfig {
    throw new Error("not used in this verification script");
  }
  getTelegramConfig(): TelegramConfig {
    throw new Error("not used in this verification script");
  }
  getRepositories(): Repository[] {
    throw new Error("not used in this verification script");
  }
  reload(): void {}
}

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "health-check-worker-"));
  const memoryDir = path.join(tempRoot, "memory");
  const healthFilePath = path.join(memoryDir, "health.json");

  try {
    assert(
      new HealthCheckWorker(new FakeConfigService(memoryDir)).id === "health-check-worker",
      "worker id is stable",
    );

    // A short interval so this script doesn't need to wait a full minute for
    // the default cadence — mirrors how other verify-*.ts scripts override
    // background workers' default intervals for fast, deterministic tests.
    const worker = new HealthCheckWorker(new FakeConfigService(memoryDir), 50);

    assert(!worker.getStatus().running, "getStatus().running is false before start()");
    assert(!existsSync(healthFilePath), "no health.json exists before the worker ever ticks");

    worker.start();
    assert(worker.getStatus().running, "getStatus().running is true after start()");

    // Wait past at least one tick.
    await sleep(200);

    assert(existsSync(healthFilePath), "health.json exists after at least one tick has run");
    const written = JSON.parse(readFileSync(healthFilePath, "utf8"));
    assert(written.status === "ok", "health.json reports status: ok");
    assert(typeof written.pid === "number" && written.pid === process.pid, "health.json reports this process's own pid");
    assert(typeof written.uptimeSeconds === "number", "health.json reports a numeric uptimeSeconds");
    assert(typeof written.writtenAt === "string" && !Number.isNaN(Date.parse(written.writtenAt)), "health.json's writtenAt is a valid ISO timestamp");

    const status = worker.getStatus();
    assert(status.lastWriteAt instanceof Date, "getStatus().lastWriteAt is set after a successful tick");
    assert(status.lastError === undefined, "getStatus().lastError is undefined after a successful tick");

    const firstWrittenAt = written.writtenAt;
    await sleep(150);
    const rewritten = JSON.parse(readFileSync(healthFilePath, "utf8"));
    assert(rewritten.writtenAt !== firstWrittenAt, "health.json is refreshed on subsequent ticks, not written once and left stale");

    worker.stop();
    assert(!worker.getStatus().running, "getStatus().running is false after stop()");

    // stop()/start() idempotency, same contract every other IBackgroundWorker honors.
    worker.stop();
    assert(!worker.getStatus().running, "calling stop() twice is a no-op, not an error");

    const staleWrittenAt = rewritten.writtenAt;
    await sleep(150);
    const afterStop = JSON.parse(readFileSync(healthFilePath, "utf8"));
    assert(afterStop.writtenAt === staleWrittenAt, "no further writes happen after stop()");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exitCode = 1;
});
