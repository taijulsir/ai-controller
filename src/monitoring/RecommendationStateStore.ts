import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IConfigService } from "../config/interfaces";
import type { Recommendation } from "../recommendations/types";
import type { MonitoringPolicy, RecommendationState, RecommendationTransition } from "./types";

const STATE_FILE_NAME = "recommendation-state.json";

// Matches ProjectMemoryService's own reviveDates pattern: JSON.stringify
// already turns firstSeen/lastSeen into ISO-8601 strings, this reviver turns
// them back into real Date objects on the way back in, so reconcile()'s own
// Date arithmetic (firstSeen.getTime()) keeps working unchanged after a
// restore() as it always did for a freshly-created state.
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function reviveDates(_key: string, value: unknown): unknown {
  if (typeof value === "string" && ISO_DATE_PATTERN.test(value)) {
    return new Date(value);
  }
  return value;
}

// One record per (repositoryId, recommendationKind), holding only lifecycle
// metadata. Mirrors ClaudeSessionManager's own "pure metadata/policy store"
// shape for its in-memory Map, but — unlike that one — this store's content
// (an already-delivered urgent/sustained alert) is wrong to silently forget
// on restart: losing it means the very next tick re-announces an unchanged
// recommendation as if it were new. configService is therefore optional
// (every existing caller that omits it, e.g. every scenario in
// verify-proactive-monitor.ts, keeps today's pure in-memory behavior
// byte-for-byte); when the composition root supplies it, restore()/persist()
// give the same Map durability across restarts, reusing the exact
// "write-JSON-to-memory.directory" pattern HealthCheckWorker/
// ProjectMemoryService already established.
export class RecommendationStateStore {
  private readonly states = new Map<string, RecommendationState>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly configService?: IConfigService,
  ) {}

  // Loads any previously-persisted state before the first reconcile() of
  // this process's lifetime. Must be called once, by the composition root,
  // before BackgroundRuntime starts ticking — reconcile() itself never
  // triggers a load. A missing file (first run ever) or no configService
  // (every existing test/script) is not an error: the store simply starts
  // empty, exactly as it always has.
  async restore(): Promise<void> {
    const filePath = this.stateFilePath();
    if (!filePath) {
      return;
    }
    let contents: string;
    try {
      contents = await readFile(filePath, "utf8");
    } catch (error) {
      if (this.isFileNotFoundError(error)) {
        return;
      }
      throw error;
    }
    const entries = JSON.parse(contents, reviveDates) as RecommendationState[];
    for (const state of entries) {
      this.states.set(this.key(state.repositoryId, state.recommendationKind), state);
    }
  }

  // Reconciles the currently-active recommendations against tracked state:
  // creates a record for a newly-seen (repository, kind) pair, refreshes
  // lastSeen/category/priority for still-active ones, and drops records for
  // recommendations no longer present — a later reappearance starts a fresh
  // streak, eligible for delivery again. Returns only the transitions that
  // just became eligible for delivery this call; the state itself (not an
  // event) is what's persisted. Unchanged from before persistence existed,
  // aside from the trailing await persist() call: every line of the
  // reconciliation/transition logic above it is untouched.
  async reconcile(repositoryId: string, recommendations: Recommendation[], policy: MonitoringPolicy): Promise<RecommendationTransition[]> {
    const nowValue = this.now();
    const activeKeys = new Set<string>();
    const transitions: RecommendationTransition[] = [];

    for (const recommendation of recommendations) {
      const key = this.key(repositoryId, recommendation.kind);
      activeKeys.add(key);

      const state = this.states.get(key) ?? this.createState(repositoryId, recommendation, nowValue);
      state.lastSeen = nowValue;
      state.category = recommendation.category;
      state.priority = recommendation.priority;
      this.states.set(key, state);

      if (this.isUrgent(state) && !state.urgentDelivered) {
        state.urgentDelivered = true;
        transitions.push({ state: { ...state }, trigger: "new-urgent-recommendation" });
      }

      const sustainedMs = nowValue.getTime() - state.firstSeen.getTime();
      if (!state.sustainedDelivered && sustainedMs >= policy.sustainedDurationMs) {
        state.sustainedDelivered = true;
        transitions.push({ state: { ...state }, trigger: "sustained-recommendation" });
      }
    }

    this.dropInactiveStates(repositoryId, activeKeys);
    await this.persist();

    return transitions;
  }

  // Best-effort durability, same failure handling as HealthCheckWorker's own
  // tick(): caught and logged, never thrown, never allowed to make a
  // monitoring cycle fail just because the state file couldn't be written.
  // Writes the full current Map every call (a snapshot, not an append-only
  // log — recommendation-state.json always reflects only currently-active
  // records, same shape dropInactiveStates() already maintains in memory).
  private async persist(): Promise<void> {
    const filePath = this.stateFilePath();
    if (!filePath) {
      return;
    }
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      const snapshot = [...this.states.values()];
      await writeFile(filePath, JSON.stringify(snapshot, null, 2), "utf8");
    } catch (error) {
      console.error("recommendation-state-store: persist failed:", error instanceof Error ? error.message : error);
    }
  }

  private stateFilePath(): string | undefined {
    if (!this.configService) {
      return undefined;
    }
    const { memory } = this.configService.getControllerConfig();
    return path.join(memory.directory, STATE_FILE_NAME);
  }

  private isFileNotFoundError(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
  }

  private createState(repositoryId: string, recommendation: Recommendation, now: Date): RecommendationState {
    return {
      repositoryId,
      recommendationKind: recommendation.kind,
      category: recommendation.category,
      priority: recommendation.priority,
      firstSeen: now,
      lastSeen: now,
      urgentDelivered: false,
      sustainedDelivered: false,
    };
  }

  private isUrgent(state: RecommendationState): boolean {
    return state.category === "blocking" || state.priority === "critical" || state.priority === "high";
  }

  private dropInactiveStates(repositoryId: string, activeKeys: Set<string>): void {
    const prefix = `${repositoryId}:`;
    const staleKeys = [...this.states.keys()].filter((key) => key.startsWith(prefix) && !activeKeys.has(key));
    for (const key of staleKeys) {
      this.states.delete(key);
    }
  }

  private key(repositoryId: string, kind: string): string {
    return `${repositoryId}:${kind}`;
  }
}
