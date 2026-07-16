import type { IRuntimeControlService } from "../control/interfaces";
import type { RuntimePolicyStatus } from "../policy/types";
import type { RuntimeStatus } from "../status/types";

// Nothing else belongs here: this is the single administrative surface over
// the whole runtime layer (monitoring, delivery, policy, status, control),
// not another operation-specific service.
export interface IRuntimeAdministrationService {
  getStatus(): RuntimeStatus;
  getControl(): IRuntimeControlService;
  getPolicies(): RuntimePolicyStatus;
}
