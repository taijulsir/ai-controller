import type { RuntimeStatus } from "./types";

export interface IRuntimeStatusService {
  getStatus(): RuntimeStatus;
}
