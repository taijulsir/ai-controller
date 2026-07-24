import { describe, expect, it } from "vitest";
import { ArtifactIndex } from "../ArtifactIndex";
import type { ArtifactMetadata } from "../types";
import { InMemoryStorage } from "./InMemoryStorage";

function makeMetadata(overrides: Partial<ArtifactMetadata>): ArtifactMetadata {
  return {
    id: overrides.id ?? "id-1",
    title: "Untitled",
    filename: "untitled.md",
    type: "markdown",
    extension: "md",
    mimeType: "text/markdown",
    size: 10,
    createdAt: new Date("2026-07-22T00:00:00.000Z"),
    createdBy: "claude",
    tags: [],
    ...overrides,
  };
}

describe("ArtifactIndex", () => {
  it("matches records against every filter field independently", () => {
    const index = new ArtifactIndex(new InMemoryStorage());
    const target = makeMetadata({
      id: "match",
      repositoryId: "repo-a",
      workflowId: "wf-a",
      correlationId: "corr-a",
      type: "sql",
      tags: ["migration", "prod"],
      derivedFromArtifactId: "parent-1",
      supersedesArtifactId: "prev-1",
      contentHash: "hash-1",
      createdAt: new Date("2026-07-22T12:00:00.000Z"),
    });
    const other = makeMetadata({ id: "other", repositoryId: "repo-b", type: "log" });
    index.add(target);
    index.add(other);

    expect(index.query({ repositoryId: "repo-a" }).map((r) => r.id)).toEqual(["match"]);
    expect(index.query({ workflowId: "wf-a" }).map((r) => r.id)).toEqual(["match"]);
    expect(index.query({ correlationId: "corr-a" }).map((r) => r.id)).toEqual(["match"]);
    expect(index.query({ type: "sql" }).map((r) => r.id)).toEqual(["match"]);
    expect(index.query({ tags: ["migration", "prod"] }).map((r) => r.id)).toEqual(["match"]);
    expect(index.query({ tags: ["migration", "nonexistent"] })).toEqual([]);
    expect(index.query({ derivedFromArtifactId: "parent-1" }).map((r) => r.id)).toEqual(["match"]);
    expect(index.query({ supersedesArtifactId: "prev-1" }).map((r) => r.id)).toEqual(["match"]);
    expect(index.query({ contentHash: "hash-1" }).map((r) => r.id)).toEqual(["match"]);
    expect(index.query({ createdAfter: new Date("2026-07-22T06:00:00.000Z") }).map((r) => r.id)).toEqual(["match"]);
    expect(index.query({ createdBefore: new Date("2026-07-22T06:00:00.000Z") }).map((r) => r.id)).toEqual(["other"]);
  });

  it("matches olderThanDays against the current time", () => {
    const index = new ArtifactIndex(new InMemoryStorage());
    const old = makeMetadata({ id: "old", createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000) });
    const recent = makeMetadata({ id: "recent", createdAt: new Date() });
    index.add(old);
    index.add(recent);

    expect(index.query({ olderThanDays: 90 }).map((r) => r.id)).toEqual(["old"]);
  });

  it("combines a filter with search, matching on title and tags", () => {
    const index = new ArtifactIndex(new InMemoryStorage());
    index.add(makeMetadata({ id: "a", title: "Security Review: auth", repositoryId: "repo-a" }));
    index.add(makeMetadata({ id: "b", title: "Release Notes", tags: ["security"], repositoryId: "repo-a" }));
    index.add(makeMetadata({ id: "c", title: "Security Review: db", repositoryId: "repo-b" }));

    const results = index.search("security", { repositoryId: "repo-a" }).map((r) => r.id);
    expect(results.sort()).toEqual(["a", "b"]);
  });

  it("rebuilds an equivalent index from metadata sidecars in storage", async () => {
    const storage = new InMemoryStorage();
    const seed = new ArtifactIndex(storage);
    const metadata = makeMetadata({ id: "seeded" });
    seed.add(metadata);
    await storage.save("2026/07/22/seeded.meta.json", JSON.stringify(metadata));

    const rebuilt = new ArtifactIndex(storage);
    await rebuilt.rebuild();

    expect(rebuilt.get("seeded")?.id).toBe("seeded");
    expect(rebuilt.get("seeded")?.createdAt).toBeInstanceOf(Date);
    expect(rebuilt.get("seeded")?.createdAt.toISOString()).toBe(metadata.createdAt.toISOString());
  });
});
