import type { IGitAdapter } from "../../git/interfaces";
import { DetachedHeadError, MergeConflictError, MissingTaskInputError, SameBranchMergeError, UnsafeGitOperationError } from "../errors";
import type { ITaskWorkflow } from "../interfaces";
import type { MergeTask, Task, WorkflowResult } from "../types";

export class MergeWorkflow implements ITaskWorkflow {
  constructor(private readonly gitAdapter: IGitAdapter) {}

  async execute(task: Task, _signal: AbortSignal): Promise<WorkflowResult> {
    const { input } = task as MergeTask;
    if (!input?.branch) {
      throw new MissingTaskInputError(task.type, "branch");
    }
    const targetBranch = input.branch;

    const currentBranch = await this.gitAdapter.currentBranch();
    if (currentBranch === "HEAD") {
      throw new DetachedHeadError("merge");
    }
    if (targetBranch === currentBranch) {
      throw new SameBranchMergeError(targetBranch);
    }

    const status = await this.gitAdapter.status();
    if (!status.isClean) {
      throw new UnsafeGitOperationError("merge", status.staged.length, status.unstaged.length, status.untracked.length);
    }

    const alreadyMerged = await this.gitAdapter.isAncestor(targetBranch, "HEAD");
    if (alreadyMerged) {
      return { success: true, output: `"${currentBranch}" is already up to date with "${targetBranch}".` };
    }

    const canFastForward = await this.gitAdapter.isAncestor("HEAD", targetBranch);
    if (canFastForward) {
      await this.gitAdapter.fastForward(targetBranch);
      return { success: true, output: `Fast-forwarded "${currentBranch}" to "${targetBranch}".` };
    }

    // Histories have genuinely diverged -- a real merge commit is the only
    // option left, and it may conflict. Never left half-finished: on any
    // failure here, the merge is unconditionally aborted before the error
    // propagates, restoring HEAD/index/working tree to exactly their
    // pre-merge state via git's own correct tool for this, not the undo
    // snapshot mechanism (which solves a different problem).
    try {
      await this.gitAdapter.mergeBranch(targetBranch);
    } catch {
      await this.gitAdapter.abortMerge();
      throw new MergeConflictError(targetBranch, currentBranch);
    }

    return { success: true, output: `Merged "${targetBranch}" into "${currentBranch}".` };
  }
}
