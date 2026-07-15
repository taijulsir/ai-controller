import type { AttentionEvent } from "./types";

export interface IProactiveMonitor {
  evaluate(repositoryId?: string): Promise<AttentionEvent[]>;
}
