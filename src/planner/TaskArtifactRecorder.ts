import path from "node:path";
import type { ArtifactDraft, ArtifactMetadata, IArtifactService } from "../artifacts";
import { GitAdapter } from "../git/GitAdapter";
import type { GitFileChange } from "../git/types";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import type { ITaskArtifactRecorder } from "./interfaces";
import type { Task, TaskResult } from "./types";

// Only these three -- the read-only, text-output workflows (Artifact
// Management scope, Phase 3). fix-bug additionally gets diff/original/
// updated-file artifacts below; implement-feature shares the identical
// checkpoint mechanism but is deliberately left out here, out of scope.
const RECORDED_TASK_TYPES: ReadonlySet<Task["type"]> = new Set(["analyze-repository", "review-code", "fix-bug"]);

// A fix touching an unusually large number of files (a rename sweep, a
// formatter run) still gets its diff + summary artifacts, just not one
// original/updated pair per file -- keeps a pathological diff from producing
// hundreds of artifacts in one run.
const MAX_FILE_CONTENT_ARTIFACTS = 20;

// A fresh GitAdapter per call, same pattern UndoCheckpointRecorder already
// uses -- cheap and stateless, scoped to one repositoryId.
export class TaskArtifactRecorder implements ITaskArtifactRecorder {
  constructor(
    private readonly artifactService: IArtifactService,
    private readonly repositoryRegistry: IRepositoryRegistry,
  ) {}

  async record(task: Task, result: TaskResult): Promise<ArtifactMetadata[]> {
    if (!result.success || !RECORDED_TASK_TYPES.has(task.type)) {
      return [];
    }

    const summary = await this.artifactService.save(
      this.summaryDraft(task, result, this.summaryTitle(task, result.repositoryId)),
    );
    const artifacts = [summary];

    if (task.type === "fix-bug" && result.checkpoint && result.repositoryId) {
      artifacts.push(...(await this.recordFixArtifacts(task, result, summary)));
    }

    return artifacts;
  }

  private async recordFixArtifacts(task: Task, result: TaskResult, summary: ArtifactMetadata): Promise<ArtifactMetadata[]> {
    const checkpoint = result.checkpoint;
    const repositoryId = result.repositoryId;
    if (!checkpoint || !repositoryId || checkpoint.beforeSnapshot === checkpoint.afterSnapshot) {
      return [];
    }

    const gitAdapter = new GitAdapter(this.repositoryRegistry, repositoryId);
    const changedFiles = await gitAdapter.diffChangedFiles(checkpoint.beforeSnapshot, checkpoint.afterSnapshot);
    if (changedFiles.length === 0) {
      return [];
    }

    const artifacts: ArtifactMetadata[] = [];

    const patch = await gitAdapter.diff(checkpoint.beforeSnapshot, checkpoint.afterSnapshot);
    const diffArtifact = await this.artifactService.save({
      title: `Fix diff — ${repositoryId}`,
      filename: `fix-${result.correlationId}.diff`,
      type: "diff",
      extension: "diff",
      content: patch,
      createdBy: "fix-bug-workflow",
      repositoryId,
      workflowId: task.type,
      correlationId: result.correlationId,
      tags: ["fix", "diff"],
      derivedFromArtifactId: summary.id,
    });
    artifacts.push(diffArtifact);

    if (changedFiles.length <= MAX_FILE_CONTENT_ARTIFACTS) {
      const relatedArtifactIds = [summary.id, diffArtifact.id];
      for (const file of changedFiles) {
        artifacts.push(
          ...(await this.recordFileContentArtifacts(gitAdapter, checkpoint, task, result, file, relatedArtifactIds)),
        );
      }
    }

    return artifacts;
  }

  private async recordFileContentArtifacts(
    gitAdapter: GitAdapter,
    checkpoint: NonNullable<TaskResult["checkpoint"]>,
    task: Task,
    result: TaskResult,
    file: GitFileChange,
    relatedArtifactIds: string[],
  ): Promise<ArtifactMetadata[]> {
    const artifacts: ArtifactMetadata[] = [];
    const extension = path.extname(file.path).replace(/^\./, "") || "txt";

    if (file.status !== "added") {
      const original = await gitAdapter.readFile(checkpoint.beforeSnapshot, file.path);
      artifacts.push(
        await this.artifactService.save(
          this.fileContentDraft(task, result, file, extension, "original", original, relatedArtifactIds),
        ),
      );
    }
    if (file.status !== "deleted") {
      const updated = await gitAdapter.readFile(checkpoint.afterSnapshot, file.path);
      artifacts.push(
        await this.artifactService.save(
          this.fileContentDraft(task, result, file, extension, "updated", updated, relatedArtifactIds),
        ),
      );
    }
    return artifacts;
  }

  private fileContentDraft(
    task: Task,
    result: TaskResult,
    file: GitFileChange,
    extension: string,
    variant: "original" | "updated",
    content: Buffer,
    relatedArtifactIds: string[],
  ): ArtifactDraft {
    return {
      title: `${variant === "original" ? "Original" : "Updated"}: ${file.path}`,
      filename: `${variant}-${path.basename(file.path)}`,
      type: extension,
      extension,
      content,
      createdBy: "fix-bug-workflow",
      repositoryId: result.repositoryId,
      workflowId: task.type,
      correlationId: result.correlationId,
      tags: ["fix", variant],
      relatedArtifactIds,
    };
  }

  private summaryDraft(task: Task, result: TaskResult, title: string): ArtifactDraft {
    return {
      title,
      filename: `${task.type}-${result.correlationId}.md`,
      type: "markdown",
      extension: "md",
      content: result.output ?? "",
      createdBy: `${task.type}-workflow`,
      repositoryId: result.repositoryId,
      workflowId: task.type,
      correlationId: result.correlationId,
      tags: [task.type],
    };
  }

  private summaryTitle(task: Task, repositoryId: string | undefined): string {
    const scope = repositoryId ? ` — ${repositoryId}` : "";
    switch (task.type) {
      case "analyze-repository":
        return `Analysis${scope}`;
      case "review-code":
        return `Code Review${scope}`;
      case "fix-bug":
        return `Fix Summary${scope}`;
      default:
        return `${task.type}${scope}`;
    }
  }
}
