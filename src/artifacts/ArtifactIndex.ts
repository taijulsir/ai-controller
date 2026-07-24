import type { Readable } from "node:stream";
import type { IArtifactStorage } from "./storage/interfaces";
import { ARTIFACT_METADATA_SUFFIX, type ArtifactFilter, type ArtifactMetadata } from "./types";

// Matches the ISO-8601 strings produced by JSON.stringify on a Date, so a
// parse reviver can round-trip createdAt without knowing the rest of the
// shape (same technique as src/memory/ProjectMemoryService.ts).
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function reviveDates(_key: string, value: unknown): unknown {
  if (typeof value === "string" && ISO_DATE_PATTERN.test(value)) {
    return new Date(value);
  }
  return value;
}

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The in-memory metadata index ArtifactService queries for list()/search()/
// deleteByFilter(). A disposable cache, not the source of truth -- the
// metadata sidecars written by ArtifactService are; rebuild() reconstructs
// this collection from them. Storage-agnostic: works against any
// IArtifactStorage, never against a concrete backend.
export class ArtifactIndex {
  private readonly recordsById = new Map<string, ArtifactMetadata>();

  constructor(private readonly storage: IArtifactStorage) {}

  add(metadata: ArtifactMetadata): void {
    this.recordsById.set(metadata.id, metadata);
  }

  remove(id: string): void {
    this.recordsById.delete(id);
  }

  get(id: string): ArtifactMetadata | undefined {
    return this.recordsById.get(id);
  }

  // Returns every match, unpaginated -- both list() and deleteByFilter()
  // build on this, so pagination (an external-listing concern) stays out of
  // it deliberately: deleteByFilter must act on the whole match set, not one
  // page of it.
  query(filter: ArtifactFilter = {}): ArtifactMetadata[] {
    return this.sorted().filter((record) => this.matchesFilter(record, filter));
  }

  search(query: string, filter: ArtifactFilter = {}): ArtifactMetadata[] {
    const needle = query.trim().toLowerCase();
    const candidates = this.query(filter);
    if (needle.length === 0) {
      return candidates;
    }
    return candidates.filter(
      (record) =>
        record.title.toLowerCase().includes(needle) || record.tags.some((tag) => tag.toLowerCase().includes(needle)),
    );
  }

  async rebuild(): Promise<void> {
    this.recordsById.clear();
    const keys = await this.storage.list();
    for (const key of keys) {
      if (!key.endsWith(ARTIFACT_METADATA_SUFFIX)) {
        continue;
      }
      const raw = await streamToString(await this.storage.read(key));
      const metadata = JSON.parse(raw, reviveDates) as ArtifactMetadata;
      this.recordsById.set(metadata.id, metadata);
    }
  }

  private sorted(): ArtifactMetadata[] {
    return [...this.recordsById.values()].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id),
    );
  }

  private matchesFilter(record: ArtifactMetadata, filter: ArtifactFilter): boolean {
    if (filter.repositoryId && record.repositoryId !== filter.repositoryId) return false;
    if (filter.workflowId && record.workflowId !== filter.workflowId) return false;
    if (filter.correlationId && record.correlationId !== filter.correlationId) return false;
    if (filter.type && record.type !== filter.type) return false;
    if (filter.contentHash && record.contentHash !== filter.contentHash) return false;
    if (filter.derivedFromArtifactId && record.derivedFromArtifactId !== filter.derivedFromArtifactId) return false;
    if (filter.supersedesArtifactId && record.supersedesArtifactId !== filter.supersedesArtifactId) return false;
    if (filter.tags && filter.tags.length > 0 && !filter.tags.every((tag) => record.tags.includes(tag))) {
      return false;
    }
    if (filter.createdAfter && record.createdAt.getTime() < filter.createdAfter.getTime()) return false;
    if (filter.createdBefore && record.createdAt.getTime() > filter.createdBefore.getTime()) return false;
    if (filter.olderThanDays !== undefined) {
      const ageMs = Date.now() - record.createdAt.getTime();
      if (ageMs < filter.olderThanDays * 24 * 60 * 60 * 1000) return false;
    }
    return true;
  }
}
