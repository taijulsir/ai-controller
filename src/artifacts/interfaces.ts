import type {
  ArtifactContent,
  ArtifactDeletionResult,
  ArtifactDraft,
  ArtifactFilter,
  ArtifactList,
  ArtifactMetadata,
} from "./types";

// The module's only public contract -- every consumer (Telegram, a future
// web UI, controller-facing producers) depends on this and nothing else
// from src/artifacts/. save()/get() return ArtifactMetadata rather than
// Artifact: see the note on Artifact in types.ts for why the storage
// location never appears here.
export interface IArtifactService {
  save(draft: ArtifactDraft): Promise<ArtifactMetadata>;
  get(id: string): Promise<ArtifactMetadata | null>;
  getContent(id: string): Promise<ArtifactContent | null>;
  exists(id: string): Promise<boolean>;
  list(filter?: ArtifactFilter): Promise<ArtifactList>;
  search(query: string, filter?: ArtifactFilter): Promise<ArtifactList>;
  delete(id: string): Promise<void>;
  deleteMany(ids: string[]): Promise<ArtifactDeletionResult>;
  deleteByFilter(filter: ArtifactFilter): Promise<ArtifactDeletionResult>;
}

// Deliberately separate from IArtifactService: rebuilding the index is an
// operational/maintenance action (storage abstraction review, Phase 10),
// not something ordinary consumers should be able to trigger. Only the
// composition root (createArtifactModule in ./index.ts) hands this out,
// and only to the one caller that specifically needs it (ApplicationService,
// which exposes it to Telegram as the admin-only "/artifact rebuild-index").
export interface IArtifactMaintenance {
  rebuildIndex(): Promise<void>;
}
