import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { GitAdapter } from "../git/GitAdapter";
import type { IApprovalGate } from "../gitorchestration/interfaces";
import { JournalOperationType } from "../journal/types";
import type { IRepositoryRegistry } from "../repositories/interfaces";
import type { IConflictResolutionEngine } from "./interfaces";
import {
  ConflictResolutionMode,
  type ConflictMarkerRange,
  type ConflictReport,
  type ConflictResolutionOutcome,
  type ConflictedFile,
} from "./types";

const CONFLICT_START = "<<<<<<<";
const CONFLICT_MIDDLE = "=======";
const CONFLICT_END = ">>>>>>>";

interface TrivialResolution {
  isTrivial: boolean;
  resolvedContent: string;
}

// Parses git's own unmerged-paths output into a structured report. Offers
// three modes, per the approved review §3, component 9: auto (only
// trivially non-overlapping or whitespace-only conflicts -- everything else
// is never silently auto-resolved), guided (approval-gated, since a single
// binary Telegram approve/reject is the only interactive primitive that
// exists today -- a full per-file ours/theirs picker is a new interaction
// mechanism this phase does not introduce), and abort (today's only
// pre-existing behavior, kept as the universal fallback).
export class ConflictResolutionEngine implements IConflictResolutionEngine {
  constructor(
    private readonly repositoryRegistry: IRepositoryRegistry,
    private readonly approvalGate: IApprovalGate,
  ) {}

  async analyze(repositoryId: string): Promise<ConflictReport> {
    const gitAdapter = new GitAdapter(this.repositoryRegistry, repositoryId);
    const repository = this.repositoryRegistry.getRepository(repositoryId);
    const [paths, binaryByPath, operation] = await Promise.all([
      gitAdapter.listConflictedFiles(),
      gitAdapter.conflictedFilesAreBinary(),
      this.detectOperation(repository.path),
    ]);

    let autoResolvableCount = 0;
    const files: ConflictedFile[] = await Promise.all(
      paths.map(async (filePath): Promise<ConflictedFile> => {
        const isBinary = binaryByPath.get(filePath) ?? false;
        if (isBinary) {
          return { path: filePath, isBinary: true, markers: undefined };
        }
        const absolutePath = path.join(repository.path, filePath);
        const [markers, resolution] = await Promise.all([
          this.findMarkers(absolutePath),
          this.computeTrivialResolution(absolutePath),
        ]);
        if (resolution.isTrivial) autoResolvableCount++;
        return { path: filePath, isBinary: false, markers };
      }),
    );

    return { operation, files, autoResolvableCount };
  }

  async resolve(repositoryId: string, report: ConflictReport, mode: ConflictResolutionMode): Promise<ConflictResolutionOutcome> {
    const gitAdapter = new GitAdapter(this.repositoryRegistry, repositoryId);
    const repository = this.repositoryRegistry.getRepository(repositoryId);

    if (mode === ConflictResolutionMode.Abort) {
      await this.abort(gitAdapter, report.operation);
      return { kind: "aborted" };
    }

    const resolved: string[] = [];
    const remaining: ConflictedFile[] = [];
    for (const file of report.files) {
      const absolutePath = path.join(repository.path, file.path);
      const resolution = file.isBinary ? { isTrivial: false, resolvedContent: "" } : await this.computeTrivialResolution(absolutePath);
      if (resolution.isTrivial) {
        await writeFile(absolutePath, resolution.resolvedContent);
        resolved.push(file.path);
      } else {
        remaining.push(file);
      }
    }

    if (remaining.length === 0) {
      // All conflicts resolved -- stage and complete the operation the same
      // way a human would after resolving conflicts by hand.
      await gitAdapter.stageAll();
      if (report.operation === JournalOperationType.Rebase) {
        await gitAdapter.continueRebase();
      } else {
        await gitAdapter.commitNoEdit();
      }
      return { kind: "resolved", filesResolved: resolved };
    }

    if (mode === ConflictResolutionMode.Auto) {
      return { kind: "needs-guidance", unresolvedFiles: remaining.map((file) => file.path) };
    }

    // Guided: only trivial conflicts are ever auto-resolved above -- for
    // anything left, the one interactive primitive available today is a
    // binary Telegram approval, so it gates aborting rather than attempting
    // an unsupervised per-file choice. Rejecting leaves the conflict open
    // for the operator to resolve manually and re-run /resume.
    const approvedAbort = await this.approvalGate.requestApproval({
      correlationId: repositoryId,
      summary: `${remaining.length} file(s) still conflicted after auto-resolution`,
      detail: `Unresolved: ${remaining.map((file) => file.path).join(", ")}. Approve to abort the ${report.operation}, or reject to resolve manually and run /resume.`,
    });
    if (approvedAbort) {
      await this.abort(gitAdapter, report.operation);
      return { kind: "aborted" };
    }
    return { kind: "needs-guidance", unresolvedFiles: remaining.map((file) => file.path) };
  }

  private async abort(gitAdapter: GitAdapter, operation: JournalOperationType): Promise<void> {
    if (operation === JournalOperationType.Rebase) {
      await gitAdapter.abortRebase();
    } else {
      await gitAdapter.abortMerge();
    }
  }

  private async detectOperation(repositoryPath: string): Promise<JournalOperationType> {
    const exists = async (candidate: string) => stat(candidate).then(() => true, () => false);
    if (await exists(path.join(repositoryPath, ".git", "rebase-merge"))) return JournalOperationType.Rebase;
    if (await exists(path.join(repositoryPath, ".git", "rebase-apply"))) return JournalOperationType.Rebase;
    return JournalOperationType.Merge;
  }

  private async findMarkers(filePath: string): Promise<ConflictMarkerRange[]> {
    const content = await readFile(filePath, "utf8").catch(() => "");
    const lines = content.split("\n");
    const ranges: ConflictMarkerRange[] = [];
    let startLine: number | undefined;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(CONFLICT_START)) {
        startLine = i;
      } else if (lines[i].startsWith(CONFLICT_END) && startLine !== undefined) {
        ranges.push({ startLine, endLine: i });
        startLine = undefined;
      }
    }
    return ranges;
  }

  // A conflict is "trivial" only when every conflicted region's two sides
  // are identical once whitespace differences are ignored -- deliberately
  // the single narrowest case this engine ever auto-resolves. Read-only:
  // callers decide separately whether to actually write resolvedContent.
  private async computeTrivialResolution(filePath: string): Promise<TrivialResolution> {
    const content = await readFile(filePath, "utf8").catch(() => undefined);
    if (content === undefined) {
      return { isTrivial: false, resolvedContent: "" };
    }
    const lines = content.split("\n");
    const resolvedLines: string[] = [];
    let i = 0;
    let sawConflict = false;

    while (i < lines.length) {
      if (!lines[i].startsWith(CONFLICT_START)) {
        resolvedLines.push(lines[i]);
        i++;
        continue;
      }
      sawConflict = true;
      const ours: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(CONFLICT_MIDDLE)) {
        ours.push(lines[i]);
        i++;
      }
      i++; // skip =======
      const theirs: string[] = [];
      while (i < lines.length && !lines[i].startsWith(CONFLICT_END)) {
        theirs.push(lines[i]);
        i++;
      }
      i++; // skip >>>>>>> marker line

      if (ours.join("\n").trim() !== theirs.join("\n").trim()) {
        return { isTrivial: false, resolvedContent: "" };
      }
      resolvedLines.push(...ours);
    }

    return sawConflict ? { isTrivial: true, resolvedContent: resolvedLines.join("\n") } : { isTrivial: false, resolvedContent: "" };
  }
}
