import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactIndex } from "../ArtifactIndex";
import { ArtifactService } from "../ArtifactService";
import { createArtifactService } from "../index";
import type { IArtifactStorage } from "../storage/interfaces";
import type { ArtifactDraft } from "../types";
import { InMemoryStorage } from "./InMemoryStorage";

function draft(overrides: Partial<ArtifactDraft> = {}): ArtifactDraft {
  return {
    title: "Architecture Proposal",
    filename: "proposal.md",
    type: "markdown",
    extension: "md",
    content: "# Proposal\n\nDetails.",
    createdBy: "claude",
    ...overrides,
  };
}

describe("ArtifactService (in-memory storage)", () => {
  let storage: InMemoryStorage;
  let service: ArtifactService;

  beforeEach(() => {
    storage = new InMemoryStorage();
    service = new ArtifactService(storage, new ArtifactIndex(storage));
  });

  it("saves an artifact and reads it back via get/getContent/exists", async () => {
    const saved = await service.save(draft());

    expect(saved.id).toBeTruthy();
    expect(saved.size).toBeGreaterThan(0);
    expect(saved.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(saved.tags).toEqual([]);
    expect(saved.storageTier).toBe("hot");
    expect("path" in saved).toBe(false);

    expect(await service.exists(saved.id)).toBe(true);
    expect(await service.get(saved.id)).toEqual(saved);

    const content = await service.getContent(saved.id);
    const chunks: Buffer[] = [];
    for await (const chunk of content!.data) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString("utf8")).toBe("# Proposal\n\nDetails.");
  });

  it("returns null/false for unknown ids without throwing", async () => {
    expect(await service.get("missing")).toBeNull();
    expect(await service.getContent("missing")).toBeNull();
    expect(await service.exists("missing")).toBe(false);
  });

  it("lists artifacts filtered by repository, type, and tags", async () => {
    await service.save(draft({ repositoryId: "repo-a", type: "markdown", tags: ["review"] }));
    await service.save(draft({ repositoryId: "repo-b", type: "sql" }));

    const byRepo = await service.list({ repositoryId: "repo-a" });
    expect(byRepo.items).toHaveLength(1);
    expect(byRepo.total).toBe(1);

    const byType = await service.list({ type: "sql" });
    expect(byType.items).toHaveLength(1);

    const unfiltered = await service.list();
    expect(unfiltered.total).toBe(2);
  });

  it("paginates list() results and exposes a cursor for the next page", async () => {
    for (let i = 0; i < 5; i += 1) {
      await service.save(draft({ title: `Artifact ${i}` }));
    }

    const firstPage = await service.list({ limit: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.total).toBe(5);
    expect(firstPage.cursor).toBeTruthy();

    const secondPage = await service.list({ limit: 2, cursor: firstPage.cursor });
    expect(secondPage.items).toHaveLength(2);

    const thirdPage = await service.list({ limit: 2, cursor: secondPage.cursor });
    expect(thirdPage.items).toHaveLength(1);
    expect(thirdPage.cursor).toBeUndefined();

    const seenIds = new Set([...firstPage.items, ...secondPage.items, ...thirdPage.items].map((item) => item.id));
    expect(seenIds.size).toBe(5);
  });

  it("searches by title and tag substrings, combined with a filter", async () => {
    await service.save(draft({ title: "Security Review: auth", repositoryId: "repo-a" }));
    await service.save(draft({ title: "Release Notes", tags: ["security"], repositoryId: "repo-a" }));
    await service.save(draft({ title: "Security Review: db", repositoryId: "repo-b" }));

    const results = await service.search("security", { repositoryId: "repo-a" });
    expect(results.items.map((item) => item.title).sort()).toEqual(["Release Notes", "Security Review: auth"]);
  });

  it("deletes a single artifact, removing both content and metadata from storage", async () => {
    const saved = await service.save(draft());
    await service.delete(saved.id);

    expect(await service.exists(saved.id)).toBe(false);
    expect(await storage.list()).toEqual([]);
  });

  it("deleteMany reports deleted and not-found ids separately", async () => {
    const saved = await service.save(draft());
    const result = await service.deleteMany([saved.id, "missing"]);

    expect(result.deletedIds).toEqual([saved.id]);
    expect(result.notFoundIds).toEqual(["missing"]);
    expect(result.skippedIds).toEqual([]);
    expect(result.failedIds).toEqual([]);
  });

  it("deleteMany reports a repeated id as skipped rather than deleting it twice", async () => {
    const saved = await service.save(draft());
    const result = await service.deleteMany([saved.id, saved.id]);

    expect(result.deletedIds).toEqual([saved.id]);
    expect(result.skippedIds).toEqual([saved.id]);
    expect(await service.exists(saved.id)).toBe(false);
  });

  it("deleteMany reports a storage failure as failed without aborting the rest of the batch", async () => {
    const ok = await service.save(draft());
    const broken = await service.save(draft({ title: "Broken" }));

    // Delegates every method to the same underlying storage except delete(),
    // which fails only for keys belonging to `broken` -- simulates e.g. a
    // permissions error on one artifact's files without affecting the other.
    const flakyStorage: IArtifactStorage = {
      save: (key, content) => storage.save(key, content),
      read: (key) => storage.read(key),
      exists: (key) => storage.exists(key),
      list: (prefix) => storage.list(prefix),
      copy: (sourceKey, destinationKey) => storage.copy(sourceKey, destinationKey),
      delete: (key) => {
        if (key.includes(broken.id)) {
          throw new Error("simulated disk failure");
        }
        return storage.delete(key);
      },
    };
    const index = new ArtifactIndex(flakyStorage);
    await index.rebuild();
    const serviceOverFlaky = new ArtifactService(flakyStorage, index);

    const result = await serviceOverFlaky.deleteMany([ok.id, broken.id]);

    expect(result.deletedIds).toEqual([ok.id]);
    expect(result.failedIds).toEqual([broken.id]);
    // The failed id must still be findable afterward -- deletion must not
    // have removed it from the index despite the storage error.
    expect(await serviceOverFlaky.exists(broken.id)).toBe(true);
  });

  it("deleteByFilter deletes exactly the matching subset", async () => {
    const keep = await service.save(draft({ repositoryId: "repo-a" }));
    const remove = await service.save(draft({ repositoryId: "repo-b" }));

    const result = await service.deleteByFilter({ repositoryId: "repo-b" });

    expect(result.deletedIds).toEqual([remove.id]);
    expect(await service.exists(keep.id)).toBe(true);
    expect(await service.exists(remove.id)).toBe(false);
  });

  it("rebuildIndex reconstructs an equivalent index from storage alone", async () => {
    const saved = await service.save(draft({ title: "Verification Report" }));

    const rebuiltIndex = new ArtifactIndex(storage);
    await rebuiltIndex.rebuild();
    const rebuiltService = new ArtifactService(storage, rebuiltIndex);

    expect(await rebuiltService.get(saved.id)).toEqual(saved);
  });
});

describe("createArtifactService (end-to-end via the public surface, real filesystem)", () => {
  let baseDirectory: string;

  beforeEach(async () => {
    baseDirectory = await mkdtemp(path.join(tmpdir(), "artifact-service-"));
  });

  afterEach(async () => {
    await rm(baseDirectory, { recursive: true, force: true });
  });

  it("supports save -> get -> list -> search -> delete through IArtifactService alone", async () => {
    const service = await createArtifactService(baseDirectory);

    const saved = await service.save(draft({ title: "Implementation Notes", tags: ["phase-11"] }));
    expect(await service.get(saved.id)).toEqual(saved);

    const listed = await service.list();
    expect(listed.items.map((item) => item.id)).toEqual([saved.id]);

    const searched = await service.search("implementation");
    expect(searched.items.map((item) => item.id)).toEqual([saved.id]);

    await service.delete(saved.id);
    expect(await service.get(saved.id)).toBeNull();
  });

  it("rebuilds a populated index when reconstructed against the same directory", async () => {
    const first = await createArtifactService(baseDirectory);
    const saved = await first.save(draft({ title: "Security Review" }));

    const second = await createArtifactService(baseDirectory);
    expect(await second.get(saved.id)).toEqual(saved);
  });
});
