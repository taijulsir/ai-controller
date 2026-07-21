import type { IGitAdapter } from "../../git/interfaces";
import { DetachedHeadError, DivergedBranchError, UnsafeGitOperationError } from "../errors";
import type { ITaskWorkflow } from "../interfaces";
import type { Task, WorkflowResult } from "../types";

// "@{upstream}" is git's own shorthand for "whatever this branch's
// configured tracking ref actually is" -- resolved by git itself, never
// hardcoded as origin/<branch>, so this works regardless of remote name or
// tracking configuration. If no upstream is configured at all, git rejects
// this ref with a clear error on its own; nothing here needs to special-case
// that.
const UPSTREAM_REF = "@{upstream}";

// /sync's one deliberate limit, by design (not a missing feature): it only
// ever fast-forwards or refuses. It never creates a merge commit, never
// rebases, and never depends on the user's own global git config the way a
// bare `git pull` would (pull.rebase/pull.ff vary by environment and are
// outside this process's control).
export class SyncWorkflow implements ITaskWorkflow {
  constructor(private readonly gitAdapter: IGitAdapter) {}

  async execute(_task: Task, _signal: AbortSignal): Promise<WorkflowResult> {
    const branch = await this.gitAdapter.currentBranch();
    if (branch === "HEAD") {
      throw new DetachedHeadError("sync");
    }

    const status = await this.gitAdapter.status();
    if (!status.isClean) {
      throw new UnsafeGitOperationError("sync", status.staged.length, status.unstaged.length, status.untracked.length);
    }

    await this.gitAdapter.fetch();

    const alreadyUpToDate = await this.gitAdapter.isAncestor(UPSTREAM_REF, "HEAD");
    if (alreadyUpToDate) {
      return { success: true, output: `"${branch}" is already up to date.` };
    }

    const canFastForward = await this.gitAdapter.isAncestor("HEAD", UPSTREAM_REF);
    if (!canFastForward) {
      throw new DivergedBranchError(branch);
    }

    await this.gitAdapter.fastForward(UPSTREAM_REF);
    return { success: true, output: `Fast-forwarded "${branch}" to its upstream.` };
  }
}
