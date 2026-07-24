import type { Readable } from "node:stream";

// Deliberately domain-agnostic -- no dependency on ../types. Deals only in
// opaque string keys and bytes, so any backend (filesystem, S3, GCS, Azure,
// encrypted storage) can implement it without knowing what an Artifact is.
// Never part of the module's public surface; only IArtifactService is.
export interface IArtifactStorage {
  save(key: string, content: Buffer | string | Readable): Promise<void>;
  read(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  list(prefix?: string): Promise<string[]>;
  // "move" is intentionally absent: every target backend implements it as
  // copy + delete anyway, so that composition happens one level up instead
  // of duplicating it in every implementation.
  copy(sourceKey: string, destinationKey: string): Promise<void>;
}
