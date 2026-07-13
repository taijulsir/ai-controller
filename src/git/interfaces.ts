import type { GitStatus } from "./types";

export interface IGitAdapter {
  status(): Promise<GitStatus>;
  currentBranch(): Promise<string>;
  checkout(branch: string): Promise<void>;
  createBranch(branch: string): Promise<void>;
  stageAll(): Promise<void>;
  commit(message: string): Promise<void>;
  push(): Promise<void>;
  pull(): Promise<void>;
}
