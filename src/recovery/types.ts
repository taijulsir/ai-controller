import type { ConflictResolutionMode } from "../gitengines/types";
import { RepositoryState } from "../gitstate/types";

export enum RecoveryStepRisk {
  // read-only or trivially reversible -- may run without approval
  Safe = "safe",
  // mutates state, but Git Transaction Manager can undo it
  Reversible = "reversible",
  // e.g. discarding uncommitted changes, force-push
  Irreversible = "irreversible",
}

export type RecoveryCommand =
  | { kind: "abort-merge" }
  | { kind: "abort-rebase" }
  | { kind: "abort-cherry-pick" }
  | { kind: "abort-revert" }
  | { kind: "abort-bisect" }
  | { kind: "resolve-conflict"; mode: ConflictResolutionMode }
  | { kind: "discard-working-tree" }
  | { kind: "remove-stale-lock"; lockPath: string }
  | { kind: "create-branch-at-head" }
  | { kind: "recommend-reclone" }
  | { kind: "resync" };

export interface RecoveryStep {
  id: string;
  // human-readable, operator-facing -- never a raw git command
  description: string;
  risk: RecoveryStepRisk;
  // derived from risk + Automatic Safety Policies, stored explicitly so a
  // plan is self-describing without re-consulting policy
  requiresApproval: boolean;
  command: RecoveryCommand;
}

export interface RecoveryPlan {
  id: string;
  repositoryId: string;
  createdAt: Date;
  detectedState: RepositoryState;
  // one line, operator-facing
  summary: string;
  // ordered -- Repository Recovery Workflow executes sequentially
  steps: RecoveryStep[];
  // literal `true`, not `boolean` -- a RecoveryPlan cannot even express
  // "trust me blindly," encoding the approved review's §9.5 edge case
  // directly into the type rather than a runtime check.
  reValidateBeforeExecution: true;
}

export interface RecoveryOutcome {
  planId: string;
  // RecoveryStep.id values
  completedSteps: string[];
  stoppedAtStep: string | undefined;
  finalState: RepositoryState;
}
