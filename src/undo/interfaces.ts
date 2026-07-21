import type { UndoOutcome, UndoPlan } from "./types";

// Two-phase by design: phase 1 (buildUndoPlan) is pure analysis -- it reads
// ExecutionStateTracker, project memory history, and git, but never mutates
// anything. Phase 2 (executeUndoPlan) is the only place that actually
// touches the filesystem or appends to history, and only ever acts on a plan
// already computed by phase 1. Splitting them (rather than one
// undoLastExecution() method doing both) is what lets a future
// "/undo --preview" call phase 1 alone and format the plan directly, a
// future Telegram confirmation flow show the plan and defer phase 2 until
// the user responds, and unit tests exercise either phase independently.
export interface IUndoService {
  buildUndoPlan(repositoryId: string): Promise<UndoPlan>;
  // Callers must only pass a plan with status "ready" (canUndo === true) --
  // see CannotExecuteUndoPlanError.
  executeUndoPlan(plan: UndoPlan): Promise<UndoOutcome>;
}
