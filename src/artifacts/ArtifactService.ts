import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { ArtifactIndex } from "./ArtifactIndex";
import type { IArtifactService } from "./interfaces";
import type { IArtifactStorage } from "./storage/interfaces";
import {
  ARTIFACT_METADATA_SUFFIX,
  type ArtifactContent,
  type ArtifactDeletionResult,
  type ArtifactDraft,
  type ArtifactFilter,
  type ArtifactList,
  type ArtifactMetadata,
  type ArtifactSummary,
} from "./types";

const DEFAULT_LIST_LIMIT = 50;

const MIME_TYPES_BY_ARTIFACT_TYPE: Record<string, string> = {
  markdown: "text/markdown",
  json: "application/json",
  sql: "application/sql",
  patch: "text/x-patch",
  diff: "text/x-diff",
  log: "text/plain",
  zip: "application/zip",
  pdf: "application/pdf",
};
const DEFAULT_MIME_TYPE = "application/octet-stream";

// Built incrementally (Phases 6-9), each stage checked against
// Pick<IArtifactService, ...> for exactly the methods that existed at that
// point -- derived from the approved interface, never hand-copied, so
// intermediate stages could never drift from it. This is the final stage:
// every IArtifactService method now exists, so the full interface is
// declared and satisfied directly.
export class ArtifactService implements IArtifactService {
  constructor(
    private readonly storage: IArtifactStorage,
    private readonly index: ArtifactIndex,
  ) {}

  async save(draft: ArtifactDraft): Promise<ArtifactMetadata> {
    const id = randomUUID();
    const createdAt = new Date();
    const key = this.contentKey(id, createdAt, draft.extension);
    const { size, contentHash } = await this.writeContent(key, draft.content);

    const metadata: ArtifactMetadata = {
      id,
      title: draft.title,
      filename: draft.filename,
      type: draft.type,
      extension: draft.extension,
      mimeType: this.resolveMimeType(draft.type),
      size,
      createdAt,
      createdBy: draft.createdBy,
      repositoryId: draft.repositoryId,
      workflowId: draft.workflowId,
      correlationId: draft.correlationId,
      tags: draft.tags ?? [],
      scope: draft.scope,
      supersedesArtifactId: draft.supersedesArtifactId,
      derivedFromArtifactId: draft.derivedFromArtifactId,
      relatedArtifactIds: draft.relatedArtifactIds,
      contentHash,
      retentionPolicy: draft.retentionPolicy,
      storageTier: "hot",
    };

    await this.storage.save(this.metadataKey(id, createdAt), JSON.stringify(metadata));
    this.index.add(metadata);

    return metadata;
  }

  async get(id: string): Promise<ArtifactMetadata | null> {
    return this.index.get(id) ?? null;
  }

  async getContent(id: string): Promise<ArtifactContent | null> {
    const metadata = this.index.get(id);
    if (!metadata) {
      return null;
    }
    const data = await this.storage.read(this.contentKey(metadata.id, metadata.createdAt, metadata.extension));
    return { metadata, data };
  }

  async exists(id: string): Promise<boolean> {
    return this.index.get(id) !== undefined;
  }

  async list(filter: ArtifactFilter = {}): Promise<ArtifactList> {
    return this.paginate(this.index.query(filter), filter);
  }

  async search(query: string, filter: ArtifactFilter = {}): Promise<ArtifactList> {
    return this.paginate(this.index.search(query, filter), filter);
  }

  async delete(id: string): Promise<void> {
    const metadata = this.index.get(id);
    if (!metadata) {
      return;
    }
    await this.removeFromStorage(metadata);
    this.index.remove(id);
  }

  async deleteMany(ids: string[]): Promise<ArtifactDeletionResult> {
    const deletedIds: string[] = [];
    const notFoundIds: string[] = [];

    for (const id of ids) {
      const metadata = this.index.get(id);
      if (!metadata) {
        notFoundIds.push(id);
        continue;
      }
      await this.removeFromStorage(metadata);
      this.index.remove(id);
      deletedIds.push(id);
    }

    return { deletedIds, notFoundIds };
  }

  // Reuses index.query() -- the same filter-matching path list() uses --
  // so deletion-by-repository/age/all is never a second, divergent
  // implementation of "which artifacts match" (lifecycle review, §10).
  async deleteByFilter(filter: ArtifactFilter): Promise<ArtifactDeletionResult> {
    return this.deleteMany(this.index.query(filter).map((record) => record.id));
  }

  // Not part of IArtifactService -- an operational entry point only the
  // composition root calls (Phase 10), never a consumer-facing method.
  async rebuildIndex(): Promise<void> {
    await this.index.rebuild();
  }

  private async removeFromStorage(metadata: ArtifactMetadata): Promise<void> {
    await this.storage.delete(this.contentKey(metadata.id, metadata.createdAt, metadata.extension));
    await this.storage.delete(this.metadataKey(metadata.id, metadata.createdAt));
  }

  private paginate(records: ArtifactMetadata[], filter: ArtifactFilter): ArtifactList {
    const limit = filter.limit ?? DEFAULT_LIST_LIMIT;
    const offset = this.decodeCursor(filter.cursor);
    const page = records.slice(offset, offset + limit);
    const nextOffset = offset + page.length;

    return {
      items: page.map((record) => this.toSummary(record)),
      total: records.length,
      cursor: nextOffset < records.length ? this.encodeCursor(nextOffset) : undefined,
    };
  }

  private encodeCursor(offset: number): string {
    return Buffer.from(String(offset), "utf8").toString("base64url");
  }

  private decodeCursor(cursor: string | undefined): number {
    if (!cursor) {
      return 0;
    }
    const offset = Number(Buffer.from(cursor, "base64url").toString("utf8"));
    return Number.isFinite(offset) && offset >= 0 ? offset : 0;
  }

  private toSummary(metadata: ArtifactMetadata): ArtifactSummary {
    const { id, title, type, size, createdAt, tags } = metadata;
    return { id, title, type, size, createdAt, tags };
  }

  // Streams source content through a pass-through hash so save() never
  // buffers the whole artifact into memory (large-artifact review) while
  // still computing size/contentHash in a single pass.
  private async writeContent(
    key: string,
    content: Buffer | string | Readable,
  ): Promise<{ size: number; contentHash: string }> {
    const source = Buffer.isBuffer(content) || typeof content === "string" ? Readable.from(content) : content;
    const hash = createHash("sha256");
    let size = 0;
    const hashing = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    });

    await this.storage.save(key, source.pipe(hashing));
    return { size, contentHash: hash.digest("hex") };
  }

  private resolveMimeType(type: string): string {
    return MIME_TYPES_BY_ARTIFACT_TYPE[type] ?? DEFAULT_MIME_TYPE;
  }

  private keyPrefix(id: string, createdAt: Date): string {
    const year = createdAt.getUTCFullYear();
    const month = String(createdAt.getUTCMonth() + 1).padStart(2, "0");
    const day = String(createdAt.getUTCDate()).padStart(2, "0");
    return `${year}/${month}/${day}/${id}`;
  }

  private contentKey(id: string, createdAt: Date, extension: string): string {
    return `${this.keyPrefix(id, createdAt)}.${extension}`;
  }

  private metadataKey(id: string, createdAt: Date): string {
    return `${this.keyPrefix(id, createdAt)}${ARTIFACT_METADATA_SUFFIX}`;
  }
}
