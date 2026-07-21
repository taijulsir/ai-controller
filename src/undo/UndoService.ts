import { GitAdapter } from "../git/GitAdapter";
import type { IExecutionStateReader } from "../executionstate/interfaces";
import type { IUndoableExecutionHistoryProvider, IUndoRecorder } from "../memory/interfaces";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import { CannotExecuteUndoPlanError } from "./errors";
import type { IUndoService } from "./interfaces";
import type { UndoOutcome, UndoPlan } from "./types";

// Phase 1 (buildUndoPlan) and phase 2 (executeUndoPlan) share this one class
// because they share the same three read-only dependencies and the same
// per-call GitAdapter construction -- splitting them into two classes would
// only duplicate that wiring, not separate any real responsibility. The
// separation that matters is the public method boundary itself: phase 1
// never calls restorePaths()/recordUndo(), phase 2 never re-derives anything
// phase 1 already computed.
export class UndoService implements IUndoService {
  constructor(
    private readonly repositoryRegistry: IRepositoryRegistry,
    private readonly executionStateReader: IExecutionStateReader,
    private readonly undoableExecutionHistoryProvider: IUndoableExecutionHistoryProvider,
    private readonly undoRecorder: IUndoRecorder,
  ) {}

  async buildUndoPlan(repositoryId: string): Promise<UndoPlan> {
    // Never undo while something is actively running for this repository --
    // its own checkpoint (if any) isn't even finished yet, and touching
    // files git currently thinks Claude/git themselves are mid-write to
    // would be actively dangerous, not just imprecise.
    if (this.executionStateReader.getCurrent(repositoryId)) {
      return this.emptyPlan(repositoryId, "execution-in-progress");
    }

    const checkpoint = await this.undoableExecutionHistoryProvider.getMostRecentUndoableExecution(repositoryId);
    if (!checkpoint) {
      return this.emptyPlan(repositoryId, "nothing-to-undo");
    }

    const gitAdapter = new GitAdapter(this.repositoryRegistry, repositoryId);

    // The stable, historical fact of what this execution actually changed --
    // diffing the two *stored* snapshots against each other, never against
    // the live working tree, so this answer never depends on anything that
    // happened after the execution finished.
    const changed = await gitAdapter.diffChangedFiles(checkpoint.beforeSnapshot, checkpoint.afterSnapshot);
    const filesToRestore = changed.filter((file) => file.status !== "added").map((file) => file.path);
    const filesToDelete = changed.filter((file) => file.status === "added").map((file) => file.path);

    // Drift check: has anything touched the SAME files since this execution
    // finished? Takes a fresh snapshot of the live state right now and diffs
    // that *tree* against afterSnapshot -- never diffs afterSnapshot against
    // "the working tree" directly (verified empirically: plain `git diff
    // <tree>` only compares tracked paths, so an execution's own untracked,
    // newly-created file would be misreported as deleted even when
    // completely untouched since). Restricted to the paths this execution
    // itself touched -- an unrelated change elsewhere in the repository must
    // never block undoing this one.
    const liveSnapshot = await gitAdapter.createSnapshot();
    const affectedPaths = new Set(changed.map((file) => file.path));
    const driftedSinceExecution = await gitAdapter.diffChangedFiles(checkpoint.afterSnapshot, liveSnapshot);
    const conflictingFiles = driftedSinceExecution.map((file) => file.path).filter((filePath) => affectedPaths.has(filePath));

    const basePlan = {
      repositoryId,
      checkpointId: checkpoint.id,
      correlationId: checkpoint.correlationId,
      taskType: checkpoint.taskType,
      filesToRestore,
      filesToDelete,
      beforeSnapshot: checkpoint.beforeSnapshot,
    };

    if (conflictingFiles.length > 0) {
      return { ...basePlan, status: "drift-detected", canUndo: false, conflictingFiles };
    }

    return { ...basePlan, status: "ready", canUndo: true, conflictingFiles: [] };
  }

  async executeUndoPlan(plan: UndoPlan): Promise<UndoOutcome> {
    if (plan.status !== "ready" || !plan.checkpointId || !plan.taskType || plan.beforeSnapshot === undefined) {
      throw new CannotExecuteUndoPlanError(plan.status);
    }

    const gitAdapter = new GitAdapter(this.repositoryRegistry, plan.repositoryId);
    await gitAdapter.restorePaths(plan.beforeSnapshot, plan.filesToRestore, plan.filesToDelete);
    await this.undoRecorder.recordUndo(plan.repositoryId, plan.checkpointId);

    return {
      kind: "undone",
      checkpointId: plan.checkpointId,
      taskType: plan.taskType,
      restoredFiles: plan.filesToRestore,
      deletedFiles: plan.filesToDelete,
    };
  }

  private emptyPlan(repositoryId: string, status: "nothing-to-undo" | "execution-in-progress"): UndoPlan {
    return { status, canUndo: false, repositoryId, filesToRestore: [], filesToDelete: [], conflictingFiles: [] };
  }
}
