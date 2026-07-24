import { randomUUID } from "node:crypto";
import type { ArtifactMetadata } from "../artifacts";
import type { IConfigService } from "../config/interfaces";
import { TaskCancelledError, TaskConcurrencyLimitExceededError, TaskTimeoutError } from "./errors";
import type {
  ITaskArtifactRecorder,
  ITaskPlanner,
  IUndoableTaskPolicy,
  IUndoCheckpointRecorder,
  IWorkflowFactory,
} from "./interfaces";
import type { ExecutionCheckpoint, Task, TaskExecutionContext, TaskResult } from "./types";

export class TaskPlanner implements ITaskPlanner {
  private runningTaskCount = 0;
  // Keyed by correlationId, the same identity ExecutionStateTracker already
  // keys its own map by -- one entry per in-flight run() call, added right
  // after the controller below is created and removed in the same finally
  // block that already clears runningTaskCount. Holds only the
  // AbortController itself: no Task, no workflow instance, no adapter
  // reference -- cancel() below is purely mechanical (abort whatever's
  // registered), it never inspects or judges what it's cancelling. That
  // judgment belongs to ITaskCancellationPolicy, consulted by
  // ApplicationService before it ever calls this method.
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(
    private readonly configService: IConfigService,
    private readonly workflowFactory: IWorkflowFactory,
    // Phase B (Undo): purely additive dependencies, same split as
    // ITaskCanceller/ITaskCancellationPolicy -- the recorder is mechanical
    // (take a snapshot now), the policy is the pure judgment of which task
    // types are worth snapshotting at all. Neither is required for run() to
    // work: undo-checkpoint capture is wrapped so a failure here can never
    // block or fail real task execution, only leave that one attempt
    // un-undoable.
    private readonly undoCheckpointRecorder: IUndoCheckpointRecorder,
    private readonly undoableTaskPolicy: IUndoableTaskPolicy,
    // Artifact Management: same "never a precondition for real task
    // execution" philosophy as undoCheckpointRecorder above -- optional, and
    // a recording failure only leaves that attempt artifact-less, wrapped in
    // recordArtifactsSafely below exactly like captureSnapshotSafely wraps
    // undoCheckpointRecorder.
    private readonly taskArtifactRecorder?: ITaskArtifactRecorder,
  ) {}

  async run(task: Task, context: TaskExecutionContext = {}): Promise<TaskResult> {
    const correlationId = context.correlationId ?? randomUUID();
    const controllerConfig = this.configService.getControllerConfig();

    if (this.runningTaskCount >= controllerConfig.task.max_concurrent_jobs) {
      throw new TaskConcurrencyLimitExceededError(controllerConfig.task.max_concurrent_jobs);
    }

    const workflow = this.workflowFactory.create(task, context);
    this.runningTaskCount++;

    const abortController = new AbortController();
    this.abortControllers.set(correlationId, abortController);
    const timeoutMinutes = controllerConfig.task.timeout_minutes;
    const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMinutes * 60_000);

    const repositoryId = context.repositoryId;
    const undoable = repositoryId !== undefined && this.undoableTaskPolicy.isUndoable(task.type);
    const beforeSnapshot = undoable ? await this.captureSnapshotSafely(repositoryId, "before") : undefined;

    try {
      const result = await Promise.race([
        workflow.execute(task, abortController.signal),
        this.rejectOnAbort(abortController.signal, task, timeoutMinutes),
      ]);
      const checkpoint = await this.buildCheckpoint(beforeSnapshot, repositoryId, correlationId, task.type);
      const taskResult: TaskResult = { ...result, taskType: task.type, repositoryId: context.repositoryId, correlationId, checkpoint };
      taskResult.artifacts = await this.recordArtifactsSafely(task, taskResult);
      return taskResult;
    } catch (error) {
      const checkpoint = await this.buildCheckpoint(beforeSnapshot, repositoryId, correlationId, task.type);
      return {
        success: false,
        taskType: task.type,
        error: error instanceof Error ? error.message : String(error),
        repositoryId: context.repositoryId,
        correlationId,
        checkpoint,
      };
    } finally {
      clearTimeout(timeoutHandle);
      this.runningTaskCount--;
      this.abortControllers.delete(correlationId);
    }
  }

  // Runs in every exit path of run() above -- success, a normal task
  // failure, a thrown error, a timeout, and a cancellation alike -- so a
  // cancelled or failed implement-feature/fix-bug is exactly as undoable as
  // a successful one, cleanly reverting whatever partial edits Claude made
  // before it stopped. Only attempts the "after" snapshot when "before" was
  // actually captured; a repositoryId is guaranteed present here (undoable
  // was already computed from it above).
  private async buildCheckpoint(
    beforeSnapshot: string | undefined,
    repositoryId: string | undefined,
    correlationId: string,
    taskType: Task["type"],
  ): Promise<ExecutionCheckpoint | undefined> {
    if (beforeSnapshot === undefined || repositoryId === undefined) {
      return undefined;
    }
    const afterSnapshot = await this.captureSnapshotSafely(repositoryId, "after");
    if (afterSnapshot === undefined) {
      return undefined;
    }
    return { id: randomUUID(), correlationId, taskType, beforeSnapshot, afterSnapshot, capturedAt: new Date() };
  }

  // Undo-checkpoint capture must never be a precondition for real task
  // execution -- same philosophy ExecutionStateTracker already follows for
  // its own tracking. A failure here is logged and degrades to "this
  // attempt simply isn't undoable," never a failed task result.
  private async captureSnapshotSafely(repositoryId: string, phase: "before" | "after"): Promise<string | undefined> {
    try {
      return await this.undoCheckpointRecorder.capture(repositoryId);
    } catch (error) {
      console.error(
        `task-planner: failed to capture undo checkpoint (${phase}) -- proceeding without one:`,
        error instanceof Error ? error.message : error,
      );
      return undefined;
    }
  }

  // Same "degrade, never block" philosophy as captureSnapshotSafely above --
  // a recording failure only leaves this one attempt without artifacts, it
  // never turns a successful task into a failed TaskResult.
  private async recordArtifactsSafely(task: Task, result: TaskResult): Promise<ArtifactMetadata[] | undefined> {
    if (!this.taskArtifactRecorder) {
      return undefined;
    }
    try {
      return await this.taskArtifactRecorder.record(task, result);
    } catch (error) {
      console.error(
        `task-planner: failed to record artifacts -- proceeding without them:`,
        error instanceof Error ? error.message : error,
      );
      return undefined;
    }
  }

  // The one place /task cancel actually reaches: aborts the AbortSignal
  // already threaded into workflow.execute() (and, once wired, into
  // ClaudeAdapter's real process kill) for whichever run() call is currently
  // registered under this correlationId. Returns false rather than throwing
  // when there is nothing to cancel, or when the same correlationId was
  // already aborted a moment ago and hasn't unwound yet -- both are normal,
  // expected outcomes for ApplicationService to distinguish, not error
  // conditions.
  cancel(correlationId: string): boolean {
    const controller = this.abortControllers.get(correlationId);
    if (!controller || controller.signal.aborted) {
      return false;
    }
    controller.abort(new TaskCancelledError());
    return true;
  }

  private rejectOnAbort(signal: AbortSignal, task: Task, timeoutMinutes: number): Promise<never> {
    return new Promise((_, reject) => {
      // Distinguishes an explicit cancel() (signal.reason is the
      // TaskCancelledError this class itself set) from the timeout timer
      // above firing a plain, reasonless abort() -- so the TaskResult a user
      // sees says "cancelled", never "timed out", when it was actually the
      // former.
      const onAbort = () => reject(signal.reason instanceof TaskCancelledError ? signal.reason : new TaskTimeoutError(task.type, timeoutMinutes));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
