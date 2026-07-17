import { mkdtempSync, rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AutonomousPlanEvolutionEngine } from "../src/planhistory/AutonomousPlanEvolutionEngine";
import { AutonomousPlanHistoryService } from "../src/planhistory/AutonomousPlanHistoryService";
import type { AutonomousPlan, AutonomousPlanItem } from "../src/autonomy/types";
import type { IConfigService } from "../src/config/interfaces";
import type { ClaudeConfig, ControllerConfig, GithubConfig, TelegramConfig } from "../src/config/types";
import type { Repository } from "../src/domain/repository/Repository";

function assert(condition: boolean, message: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${message}`);
}

function item(overrides: Partial<AutonomousPlanItem> & Pick<AutonomousPlanItem, "repositoryId" | "sourceRecommendationKind">): AutonomousPlanItem {
  return { category: "advisory", priority: "medium", reason: "test", supportingEvidence: [], confidence: "medium", ...overrides };
}

// A padding field bloats each plan's serialized size well past
// TAIL_READ_CHUNK_BYTES's own internal chunk size when repeated across many
// cycles, and — used alone, on a single cycle — can exceed one chunk by
// itself, exercising the "one line spans multiple chunks" path directly.
function plan(id: string, paddingBytes = 0): AutonomousPlan {
  return {
    id,
    generatedAt: new Date(),
    repositoriesConsidered: ["alpha"],
    items: [item({ repositoryId: "alpha", sourceRecommendationKind: "PullRequired", reason: paddingBytes > 0 ? "x".repeat(paddingBytes) : "test" })],
  };
}

class FakeConfigService implements IConfigService {
  constructor(private readonly directory: string) {}
  getControllerConfig(): ControllerConfig {
    return {
      controller: { name: "test", version: "0.0.0", environment: "test" },
      workspace: { root: "/tmp" },
      task: { max_concurrent_jobs: 1, timeout_minutes: 1 },
      approval: { mode: "manual", require_before_git_push: true, require_before_pull_request: true },
      logging: { enabled: false, level: "info", directory: "/tmp" },
      memory: { enabled: true, directory: this.directory },
    };
  }
  getClaudeConfig(): ClaudeConfig {
    throw new Error("not used");
  }
  getGithubConfig(): GithubConfig {
    throw new Error("not used");
  }
  getTelegramConfig(): TelegramConfig {
    throw new Error("not used");
  }
  getRepositories(): Repository[] {
    throw new Error("not used");
  }
  reload(): void {
    throw new Error("not used");
  }
}

async function main(): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "plan-history-tail-read-verify-"));
  try {
    const configService = new FakeConfigService(directory);
    const evolutionEngine = new AutonomousPlanEvolutionEngine();
    const service = new AutonomousPlanHistoryService(configService, evolutionEngine);
    const historyFilePath = path.join(directory, "autonomous-plans.jsonl");

    // Large-history correctness: record far more cycles than any single
    // TAIL_READ_CHUNK_BYTES chunk could hold at once (each entry is padded
    // to ~2KB, so 500 cycles is roughly 1MB of accumulated history -- many
    // chunks' worth), then verify getLatestEntry()/getHistory() still
    // return exactly the right data.
    const CYCLE_COUNT = 500;
    for (let i = 1; i <= CYCLE_COUNT; i += 1) {
      await service.record(plan(`p${i}`, 2000));
    }

    const fileSize = statSync(historyFilePath).size;
    assert(fileSize > 500_000, `large-history fixture actually accumulated a large file (saw ${fileSize} bytes) -- this test is exercising the multi-chunk path, not a trivially small one`);

    const latest = await service.getLatestEntry();
    assert(latest?.plan.id === `p${CYCLE_COUNT}`, `getLatestEntry() returns the true newest cycle (p${CYCLE_COUNT}) out of ${CYCLE_COUNT} accumulated cycles, not a stale or wrong one`);
    assert(latest?.cycleNumber === CYCLE_COUNT, "getLatestEntry() reports the correct cycleNumber for the newest of a large accumulated history");

    const history20 = await service.getHistory();
    assert(history20.length === 20, "getHistory() with no limit still defaults to 20 entries against a 500-entry history");
    assert(history20[0]?.plan.id === `p${CYCLE_COUNT}`, "getHistory()'s first (newest) entry is the true latest cycle");
    assert(history20[19]?.plan.id === `p${CYCLE_COUNT - 19}`, "getHistory()'s 20th entry is exactly 20 cycles back, newest-first ordering preserved against a large history");
    assert(
      history20.map((e) => e.cycleNumber).join(",") === Array.from({ length: 20 }, (_, i) => CYCLE_COUNT - i).join(","),
      "getHistory() returns a contiguous, correctly-ordered newest-first window even when the underlying file is far larger than the window requested",
    );

    const history3 = await service.getHistory(3);
    assert(history3.map((e) => e.plan.id).join(",") === `p${CYCLE_COUNT},p${CYCLE_COUNT - 1},p${CYCLE_COUNT - 2}`, "getHistory(3) against a 500-entry history returns exactly the newest 3, in order");

    const historyAll = await service.getHistory(CYCLE_COUNT + 100);
    assert(historyAll.length === CYCLE_COUNT, "requesting more entries than exist returns every entry, not an error or a fabricated fallback");
    assert(historyAll[historyAll.length - 1]?.plan.id === "p1", "requesting the full history still returns the true first-ever recorded cycle at the tail end");

    // Complete accumulation: nothing was capped, trimmed, or deleted --
    // reading the raw file directly confirms every one of the 500 lines this
    // test wrote is still present on disk.
    const rawLines = (await readFile(historyFilePath, "utf8")).split("\n").filter((l) => l.trim().length > 0);
    assert(rawLines.length === CYCLE_COUNT, `the on-disk file still contains all ${CYCLE_COUNT} recorded cycles -- no retention or deletion occurred as a side effect of the tail-read optimization`);

    // Chunk-boundary robustness: a single entry whose own serialized size
    // exceeds TAIL_READ_CHUNK_BYTES (64KB) must still be read completely and
    // correctly -- the multi-chunk-per-line path, not just multi-line-per-chunk.
    await service.record(plan("huge", 80_000));
    const afterHuge = await service.getLatestEntry();
    assert(afterHuge?.plan.id === "huge", "a single entry larger than one tail-read chunk is still returned completely and correctly");
    assert(afterHuge?.plan.items[0]?.reason.length === 80_000, "a huge entry's full content survives the multi-chunk tail read intact, not truncated");

    // Reading again immediately afterward must still be correct -- proves
    // the multi-chunk-per-line path leaves the service in a consistent
    // state, not just correct on the one call that triggered it.
    const stillLatest = await service.getLatestEntry();
    assert(stillLatest?.plan.id === "huge", "getLatestEntry() remains correct on a second call immediately after a huge entry");

    // Zero/undersized requests
    assert((await service.getHistory(0)).length === 0, "getHistory(0) returns an empty array, matching the original slice(0, 0) behavior exactly");

    // Empty-history edge case, exercised on a fresh instance/directory so
    // the file genuinely does not exist yet -- confirms readTailLines()'s
    // ENOENT handling still returns [] / undefined rather than throwing.
    const emptyDirectory = mkdtempSync(path.join(tmpdir(), "plan-history-tail-read-empty-"));
    try {
      const emptyService = new AutonomousPlanHistoryService(new FakeConfigService(emptyDirectory), evolutionEngine);
      assert((await emptyService.getLatestEntry()) === undefined, "getLatestEntry() on a never-written history returns undefined, not an error, via the tail-read path");
      assert((await emptyService.getHistory()).length === 0, "getHistory() on a never-written history returns [], via the tail-read path");
    } finally {
      rmSync(emptyDirectory, { recursive: true, force: true });
    }

    // Single-entry history: exercises the "reached start of file before
    // collecting enough lines" branch of the backward-read loop directly.
    const singleDirectory = mkdtempSync(path.join(tmpdir(), "plan-history-tail-read-single-"));
    try {
      const singleService = new AutonomousPlanHistoryService(new FakeConfigService(singleDirectory), evolutionEngine);
      await singleService.record(plan("only-one"));
      const singleLatest = await singleService.getLatestEntry();
      assert(singleLatest?.plan.id === "only-one", "getLatestEntry() against a one-entry history correctly reaches the start of the file and returns that one entry");
      const singleHistory = await singleService.getHistory(10);
      assert(singleHistory.length === 1 && singleHistory[0]?.plan.id === "only-one", "getHistory(10) against a one-entry history returns just the one entry that exists, not an error or padding");
    } finally {
      rmSync(singleDirectory, { recursive: true, force: true });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

main();
