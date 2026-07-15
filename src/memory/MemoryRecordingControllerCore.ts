import type { IControllerCore } from "../controller/interfaces";
import type { ExecutionRequest, ExecutionResult } from "../controller/types";
import type { IProjectMemoryService } from "./interfaces";
import type { ProjectMemoryOutcome } from "./types";

// Decorator around IControllerCore, mirroring how ApprovalEngine already
// decorates ControllerCore. Recording must never affect the real outcome: a
// memory-write failure is swallowed (and only logged to console.error) so it
// can never fail or delay the action the caller actually asked for.
//
// Wraps the outermost layer in src/index.ts (above ApprovalEngine), so every
// execution that crosses it gets a Project Memory event.
export class MemoryRecordingControllerCore implements IControllerCore {
  constructor(
    private readonly inner: IControllerCore,
    private readonly projectMemory: IProjectMemoryService,
  ) {}

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    try {
      const result = await this.inner.execute(request);
      this.recordSafely(request, { kind: "result", result });
      return result;
    } catch (error) {
      this.recordSafely(request, { kind: "error", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private recordSafely(request: ExecutionRequest, outcome: ProjectMemoryOutcome): void {
    this.projectMemory.record(request, outcome).catch((error) => {
      console.error("project-memory: failed to record event:", error instanceof Error ? error.message : error);
    });
  }
}
