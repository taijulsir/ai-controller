import { GitAdapter } from "../git/GitAdapter";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import type { IUndoCheckpointRecorder } from "./interfaces";

// A fresh GitAdapter per call, same pattern RepositoryIntelligenceService and
// WorkflowFactory already use -- GitAdapter is cheap and stateless, scoped to
// one repositoryId, never held as a long-lived reference.
export class UndoCheckpointRecorder implements IUndoCheckpointRecorder {
  constructor(private readonly repositoryRegistry: IRepositoryRegistry) {}

  async capture(repositoryId: string): Promise<string> {
    return new GitAdapter(this.repositoryRegistry, repositoryId).createSnapshot();
  }
}
