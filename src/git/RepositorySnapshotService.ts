import type { IRepositoryRegistry } from "../repositories/interfaces";
import { GitAdapter } from "./GitAdapter";
import type { IRepositorySnapshotService } from "./interfaces";
import type { GitFileChange } from "./types";

// Generalizes GitAdapter.createSnapshot()/diffChangedFiles()/restorePaths()
// -- already used exclusively by the undo mechanism before this phase --
// into a shared primitive any component can call. A thin delegate, not a new
// implementation: no new git plumbing is invented here, matching the
// approved review's own framing of this component.
export class RepositorySnapshotService implements IRepositorySnapshotService {
  constructor(private readonly repositoryRegistry: IRepositoryRegistry) {}

  async capture(repositoryId: string): Promise<string> {
    return new GitAdapter(this.repositoryRegistry, repositoryId).createSnapshot();
  }

  async diff(repositoryId: string, fromRef: string, toRef: string): Promise<GitFileChange[]> {
    return new GitAdapter(this.repositoryRegistry, repositoryId).diffChangedFiles(fromRef, toRef);
  }

  async restore(
    repositoryId: string,
    fromRef: string,
    filesToRestore: string[],
    filesToDelete: string[],
  ): Promise<void> {
    return new GitAdapter(this.repositoryRegistry, repositoryId).restorePaths(fromRef, filesToRestore, filesToDelete);
  }
}
