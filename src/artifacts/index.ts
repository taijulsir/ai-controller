import path from "node:path";
import { ArtifactIndex } from "./ArtifactIndex";
import { ArtifactService } from "./ArtifactService";
import { FilesystemStorage } from "./storage/FilesystemStorage";
import type { IArtifactMaintenance, IArtifactService } from "./interfaces";

export type { IArtifactMaintenance, IArtifactService } from "./interfaces";
export * from "./types";

export interface ArtifactModule {
  service: IArtifactService;
  maintenance: IArtifactMaintenance;
}

// The module's real construction entry point. Wires FilesystemStorage +
// ArtifactIndex + ArtifactService together and rebuilds the index from
// whatever's already on disk before returning, so a service constructed
// after a process restart reflects existing artifacts immediately.
// service and maintenance are two views over the same ArtifactService
// instance -- maintenance exposes rebuildIndex() only to a caller that
// explicitly asks for it, never through the ordinary IArtifactService path.
export async function createArtifactModule(baseDirectory: string): Promise<ArtifactModule> {
  const storage = new FilesystemStorage(path.resolve(baseDirectory));
  const index = new ArtifactIndex(storage);
  const service = new ArtifactService(storage, index);
  await service.rebuildIndex();
  return { service, maintenance: service };
}

// Convenience entry point for the common case (only IArtifactService is
// needed) -- unchanged in behavior and signature from before
// createArtifactModule existed.
export async function createArtifactService(baseDirectory: string): Promise<IArtifactService> {
  return (await createArtifactModule(baseDirectory)).service;
}
