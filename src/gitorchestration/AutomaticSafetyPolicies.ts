import type { IConfigService } from "../config/interfaces";
import type { RepositoryHealthReport } from "../git/types";
import { JournalOperationType } from "../journal/types";
import type { IAutomaticSafetyPolicies } from "./interfaces";
import { DivergenceStrategy, OperationClassification } from "./types";

// Rebase is always approval-gated regardless of context (a direct /rebase or
// a /sync delegating to it) -- more conservative than the approved review's
// own classification table technically requires (which only called out
// "rebase onto a non-upstream target"), chosen deliberately: rebasing
// rewrites history even when it's "just" catching up to upstream, and this
// classifier has no signal to distinguish the two cases from `operation`
// alone. Documented as a simplification in the implementation report.
const HARDCODED_APPROVAL_OPERATIONS: ReadonlySet<JournalOperationType> = new Set([JournalOperationType.Rebase]);

// The floor the approved review's §8 calls "the line that must never move" --
// a code constant, never a config value. A safety floor that can be edited
// out of a YAML file is not a floor.
//
// classify() deliberately never re-reads approval.require_before itself:
// every operation this method is ever asked to classify has already passed
// through ApprovalEngine/ApprovalPolicy first (Command Orchestrator is only
// ever reached from a workflow that WorkflowFactory builds, which only ever
// runs behind the ApprovalEngine-wrapped ControllerCore -- see src/index.ts),
// and ApprovalPolicy.requiresApproval() already checks require_before
// generically against any task.type, not just merge/push. A second,
// independent config-driven check here previously duplicated that gate --
// every operation config listed in require_before triggered two separate
// Telegram approval prompts for the one command. This layer's only
// remaining job is the hardcoded floor above, which config can never turn
// off.
export class AutomaticSafetyPolicies implements IAutomaticSafetyPolicies {
  constructor(private readonly configService: IConfigService) {}

  classify(operation: JournalOperationType, report: RepositoryHealthReport): OperationClassification {
    // Fetch is exempt from the in-progress-operation short-circuit, same as
    // Pre-flight Validation Policy's own IN_PROGRESS_OPERATIONS set
    // deliberately excludes it: fetch only updates remote-tracking refs, so
    // it is always safe to run even mid-merge/mid-rebase.
    if (operation !== JournalOperationType.Fetch && (report.inProgressOperation || report.interruptedOperation)) {
      return OperationClassification.RecommendRecovery;
    }
    if (HARDCODED_APPROVAL_OPERATIONS.has(operation)) {
      return OperationClassification.RequestApproval;
    }
    return OperationClassification.ContinueAutomatically;
  }

  divergenceStrategy(_repositoryId: string): DivergenceStrategy {
    const raw = this.configService.getControllerConfig().git_orchestration?.divergence_strategy ?? "rebase";
    switch (raw) {
      case "merge":
        return DivergenceStrategy.Merge;
      case "ask":
        return DivergenceStrategy.Ask;
      default:
        return DivergenceStrategy.Rebase;
    }
  }
}
