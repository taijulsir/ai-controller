import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactIndex } from "../../artifacts/ArtifactIndex";
import { ArtifactService } from "../../artifacts/ArtifactService";
import { InMemoryStorage } from "../../artifacts/__tests__/InMemoryStorage";
import { GitAdapter } from "../../git/GitAdapter";
import type { Repository } from "../../domain/repository/Repository";
import type { IRepositoryRegistry } from "../../repositories/interfaces";
import { TaskArtifactRecorder } from "../TaskArtifactRecorder";
import type { Task, TaskResult } from "../types";

const execFileAsync = promisify(execFile);

function fakeRegistry(repository: Repository): IRepositoryRegistry {
  return {
    getAllRepositories: () => [repository],
    getRepository: () => repository,
    getActiveRepository: () => repository,
    setActiveRepository: () => {},
    repositoryExists: () => true,
    refresh: () => {},
  };
}

async function readArtifactBuffer(artifactService: ArtifactService, id: string): Promise<Buffer> {
  const content = await artifactService.getContent(id);
  if (!content) throw new Error(`artifact ${id} not found`);
  const chunks: Buffer[] = [];
  for await (const chunk of content.data) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readArtifactText(artifactService: ArtifactService, id: string): Promise<string> {
  return (await readArtifactBuffer(artifactService, id)).toString("utf8");
}

describe("TaskArtifactRecorder", () => {
  let repoPath: string;
  let repository: Repository;
  let recorder: TaskArtifactRecorder;
  let artifactService: ArtifactService;
  let gitAdapter: GitAdapter;

  beforeEach(async () => {
    repoPath = await mkdtemp(path.join(tmpdir(), "task-artifact-recorder-repo-"));
    await execFileAsync("git", ["init"], { cwd: repoPath });
    repository = { id: "repo1", name: "repo1", path: repoPath, defaultBranch: "main", active: true };

    const storage = new InMemoryStorage();
    const index = new ArtifactIndex(storage);
    artifactService = new ArtifactService(storage, index);
    recorder = new TaskArtifactRecorder(artifactService, fakeRegistry(repository));
    gitAdapter = new GitAdapter(fakeRegistry(repository), repository.id);
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  function baseResult(overrides: Partial<TaskResult>): TaskResult {
    return {
      success: true,
      output: "Did the thing.",
      taskType: "analyze-repository",
      repositoryId: repository.id,
      correlationId: "corr-1",
      ...overrides,
    };
  }

  it("saves a single summary artifact for analyze-repository", async () => {
    const task: Task = { type: "analyze-repository" };
    const artifacts = await recorder.record(task, baseResult({ taskType: "analyze-repository" }));

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe("markdown");
    expect(artifacts[0].tags).toContain("analyze-repository");
    expect(await readArtifactText(artifactService, artifacts[0].id)).toBe("Did the thing.");
  });

  it("saves a single summary artifact for review-code", async () => {
    const task: Task = { type: "review-code" };
    const artifacts = await recorder.record(task, baseResult({ taskType: "review-code" }));

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].tags).toContain("review-code");
  });

  it("records nothing for a failed task", async () => {
    const task: Task = { type: "analyze-repository" };
    const artifacts = await recorder.record(task, baseResult({ taskType: "analyze-repository", success: false, error: "boom" }));

    expect(artifacts).toEqual([]);
  });

  it("records nothing for a task type outside Artifact Management scope", async () => {
    const task: Task = { type: "create-commit", input: { message: "x" } };
    const artifacts = await recorder.record(task, baseResult({ taskType: "create-commit" }));

    expect(artifacts).toEqual([]);
  });

  it("records only a summary for fix-bug when no files changed", async () => {
    await writeFile(path.join(repoPath, "a.txt"), "before");
    const snapshot = await gitAdapter.createSnapshot();

    const task: Task = { type: "fix-bug", input: { description: "no-op" } };
    const result = baseResult({
      taskType: "fix-bug",
      checkpoint: {
        id: "chk-1",
        correlationId: "corr-1",
        taskType: "fix-bug",
        beforeSnapshot: snapshot,
        afterSnapshot: snapshot,
        capturedAt: new Date(),
      },
    });

    const artifacts = await recorder.record(task, result);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].tags).toContain("fix-bug");
  });

  it("records summary, diff, and per-file original/updated artifacts for fix-bug", async () => {
    await writeFile(path.join(repoPath, "a.txt"), "before\n");
    const beforeSnapshot = await gitAdapter.createSnapshot();

    await writeFile(path.join(repoPath, "a.txt"), "after\n");
    await writeFile(path.join(repoPath, "b.txt"), "new file\n");
    const afterSnapshot = await gitAdapter.createSnapshot();

    const task: Task = { type: "fix-bug", input: { description: "fix a, add b" } };
    const result = baseResult({
      taskType: "fix-bug",
      output: "Changed a.txt and added b.txt.",
      checkpoint: {
        id: "chk-1",
        correlationId: "corr-1",
        taskType: "fix-bug",
        beforeSnapshot,
        afterSnapshot,
        capturedAt: new Date(),
      },
    });

    const artifacts = await recorder.record(task, result);

    // summary + diff + (a.txt original + a.txt updated) + (b.txt updated only)
    expect(artifacts).toHaveLength(5);

    const summary = artifacts.find((a) => a.type === "markdown");
    expect(summary).toBeDefined();
    expect(await readArtifactText(artifactService, summary!.id)).toBe("Changed a.txt and added b.txt.");

    const diff = artifacts.find((a) => a.type === "diff");
    expect(diff).toBeDefined();
    const diffText = await readArtifactText(artifactService, diff!.id);
    expect(diffText).toContain("a.txt");
    expect(diff!.derivedFromArtifactId).toBe(summary!.id);

    const originalA = artifacts.find((a) => a.title === "Original: a.txt");
    expect(originalA).toBeDefined();
    expect(await readArtifactText(artifactService, originalA!.id)).toBe("before\n");

    const updatedA = artifacts.find((a) => a.title === "Updated: a.txt");
    expect(updatedA).toBeDefined();
    expect(await readArtifactText(artifactService, updatedA!.id)).toBe("after\n");

    const originalB = artifacts.find((a) => a.title === "Original: b.txt");
    expect(originalB).toBeUndefined();

    const updatedB = artifacts.find((a) => a.title === "Updated: b.txt");
    expect(updatedB).toBeDefined();
    expect(await readArtifactText(artifactService, updatedB!.id)).toBe("new file\n");
  });

  // Regression: git show's stdout was previously forced through UTF-8 string
  // decoding, which replaces any invalid byte sequence with U+FFFD --
  // silently corrupting binary content (verified: a 17-byte PNG-style header
  // became 29 bytes). readFile()/runBinary() must round-trip raw bytes
  // exactly.
  it("preserves exact bytes for a binary file changed by fix-bug", async () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01, 0x02, 0x80, 0x81, 0xc3, 0x28]);
    const binaryUpdated = Buffer.from([...binary, 0x00, 0xfd]);

    await writeFile(path.join(repoPath, "image.png"), binary);
    const beforeSnapshot = await gitAdapter.createSnapshot();

    await writeFile(path.join(repoPath, "image.png"), binaryUpdated);
    const afterSnapshot = await gitAdapter.createSnapshot();

    const task: Task = { type: "fix-bug", input: { description: "tweak image" } };
    const result = baseResult({
      taskType: "fix-bug",
      checkpoint: {
        id: "chk-2",
        correlationId: "corr-1",
        taskType: "fix-bug",
        beforeSnapshot,
        afterSnapshot,
        capturedAt: new Date(),
      },
    });

    const artifacts = await recorder.record(task, result);
    const originalImage = artifacts.find((a) => a.title === "Original: image.png");
    const updatedImage = artifacts.find((a) => a.title === "Updated: image.png");
    expect(originalImage).toBeDefined();
    expect(updatedImage).toBeDefined();

    expect(Buffer.compare(await readArtifactBuffer(artifactService, originalImage!.id), binary)).toBe(0);
    expect(Buffer.compare(await readArtifactBuffer(artifactService, updatedImage!.id), binaryUpdated)).toBe(0);
  });
});
