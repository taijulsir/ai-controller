import type { Readable } from "node:stream";

// Known types get autocomplete; the union stays open (any string is
// assignable) so a new artifact kind never requires a model change --
// see the Artifact Management extensibility review.
export type ArtifactType = "markdown" | "json" | "sql" | "patch" | "diff" | "log" | "image" | "zip" | "pdf" | string;

export type ArtifactScope = "internal" | "shared";

export type ArtifactStorageTier = "hot" | "cold";

// Shared by ArtifactService (writes the sidecar) and ArtifactIndex (finds it
// during rebuild) so the two never risk disagreeing on the convention.
export const ARTIFACT_METADATA_SUFFIX = ".meta.json";

export interface ArtifactMetadata {
  id: string;
  title: string;
  filename: string;
  type: ArtifactType;
  extension: string;
  mimeType: string;
  size: number;
  createdAt: Date;
  createdBy: string;
  repositoryId?: string;
  workflowId?: string;
  correlationId?: string;
  tags: string[];
  scope?: ArtifactScope;
  // Lifecycle review: linear "this replaces that" pointer -- distinct from
  // derivedFromArtifactId's compositional relationship.
  supersedesArtifactId?: string;
  derivedFromArtifactId?: string;
  relatedArtifactIds?: string[];
  contentHash?: string;
  retentionPolicy?: string;
  storageTier?: ArtifactStorageTier;
}

// Internal-only: bundles ArtifactMetadata with its storage location.
// IArtifactService never returns this -- save()/get() return ArtifactMetadata
// so callers outside the module never see a storage key (storage abstraction
// review, path-safety section). Kept only as a type; ArtifactService derives
// the location deterministically from (id, createdAt, extension) rather than
// storing it, so no value of this shape is ever constructed at runtime.
export interface Artifact extends ArtifactMetadata {
  path: string;
}

export interface ArtifactContent {
  metadata: ArtifactMetadata;
  data: Readable;
}

export type ArtifactSummary = Pick<ArtifactMetadata, "id" | "title" | "type" | "size" | "createdAt" | "tags">;

export interface ArtifactDraft {
  title: string;
  filename: string;
  type: ArtifactType;
  extension: string;
  content: Buffer | string | Readable;
  createdBy: string;
  repositoryId?: string;
  workflowId?: string;
  correlationId?: string;
  tags?: string[];
  scope?: ArtifactScope;
  supersedesArtifactId?: string;
  derivedFromArtifactId?: string;
  relatedArtifactIds?: string[];
  retentionPolicy?: string;
}

export interface ArtifactFilter {
  repositoryId?: string;
  workflowId?: string;
  correlationId?: string;
  type?: ArtifactType;
  tags?: string[];
  createdAfter?: Date;
  createdBefore?: Date;
  olderThanDays?: number;
  derivedFromArtifactId?: string;
  supersedesArtifactId?: string;
  contentHash?: string;
  limit?: number;
  cursor?: string;
}

export interface ArtifactList {
  items: ArtifactSummary[];
  total: number;
  cursor?: string;
}

export interface ArtifactDeletionResult {
  deletedIds: string[];
  notFoundIds: string[];
  // A later occurrence of an id already seen earlier in the same request --
  // reported distinctly from notFoundIds so a caller can tell "you asked
  // twice" apart from "that id doesn't exist."
  skippedIds: string[];
  // Existed in the index but storage removal itself threw (e.g. a disk
  // error) -- distinct from notFoundIds, and never allowed to abort the
  // rest of the batch (see ArtifactService.deleteMany's own doc comment).
  failedIds: string[];
}
