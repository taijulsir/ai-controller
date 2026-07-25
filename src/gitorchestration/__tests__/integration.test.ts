import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IConfigService } from "../../config/interfaces";
import type { ControllerConfig } from "../../config/types";
import type { Repository } from "../../domain/repository/Repository";
import { GitAdapter } from "../../git/GitAdapter";
import { GitHealthService } from "../../git/GitHealthService";
import { RepositorySnapshotService } from "../../git/RepositorySnapshotService";
import { ConflictResolutionEngine } from "../../gitengines/ConflictResolutionEngine";
import { IntelligentSyncEngine } from "../../gitengines/IntelligentSyncEngine";
import { MergeEngine } from "../../gitengines/MergeEngine";
import { RebaseEngine } from "../../gitengines/RebaseEngine";
import { GitTransactionManager } from "../../gittransaction/GitTransactionManager";
import { GitStateMachine } from "../../gitstate/GitStateMachine";
import { RepositoryStateAnalyzer } from "../../gitstate/RepositoryStateAnalyzer";
import { RepositoryState } from "../../gitstate/types";
import { createOperationJournal } from "../../journal/index";
import { JournalEntryStatus, JournalOperationType } from "../../journal/types";
import { RecoveryPlanner } from "../../recovery/RecoveryPlanner";
import { RepositoryRecoveryWorkflow } from "../../recovery/RepositoryRecoveryWorkflow";
import type { IRepositoryRegistry } from "../../repositories/interfaces";
import { AutomaticSafetyPolicies } from "../AutomaticSafetyPolicies";
import { CommandOrchestrator } from "../CommandOrchestrator";
import type { IApprovalGate } from "../interfaces";
import { PreflightValidationPolicy } from "../PreflightValidationPolicy";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

function fakeRegistry(repository: Repository): IRepositoryRegistry {
  return {
    getAllRepositories: () => [repository],
    getRepository: () => repository,
    getActiveRepository: () => repository,
    setActiveRepository: () => {},
    repositoryExists: () => true,
    refresh: () => {},
  };
}

function fakeConfigService(divergenceStrategy?: "rebase" | "merge" | "ask"): IConfigService {
  const config: ControllerConfig = {
    controller: { name: "test", version: "0.0.0", environment: "test" },
    workspace: { root: "/tmp" },
    task: { max_concurrent_jobs: 1, timeout_minutes: 10 },
    approval: { mode: "manual" },
    logging: { enabled: false, level: "info", directory: "/tmp" },
    memory: { enabled: false, directory: "/tmp" },
    git_orchestration: divergenceStrategy ? { divergence_strategy: divergenceStrategy } : undefined,
  };
  return {
    getControllerConfig: () => config,
    getClaudeConfig: () => {
      throw new Error("not needed");
    },
    getGithubConfig: () => {
      throw new Error("not needed");
    },
    getTelegramConfig: () => {
      throw new Error("not needed");
    },
    getRepositories: () => [],
    reload: () => {},
  };
}

const alwaysApprove: IApprovalGate = { requestApproval: async () => true };
const alwaysDecline: IApprovalGate = { requestApproval: async () => false };

function countingApprovalGate(decision: boolean): IApprovalGate & { calls: number } {
  return {
    calls: 0,
    async requestApproval() {
      this.calls += 1;
      return decision;
    },
  };
}

async function setupDivergedRepo(workDir: string, originDir: string, writerDir: string): Promise<void> {
  await git(originDir, ["init", "--bare", "-b", "main"]);

  await git(workDir, ["init", "-b", "main"]);
  await git(workDir, ["config", "user.email", "test@example.com"]);
  await git(workDir, ["config", "user.name", "Test"]);
  await git(workDir, ["remote", "add", "origin", originDir]);
  await writeFile(path.join(workDir, "base.txt"), "base\n");
  await git(workDir, ["add", "base.txt"]);
  await git(workDir, ["commit", "-m", "init"]);
  await git(workDir, ["push", "-u", "origin", "main"]);

  // Simulate a teammate pushing a commit to the shared remote.
  await git(writerDir, ["clone", originDir, "."]);
  await git(writerDir, ["config", "user.email", "writer@example.com"]);
  await git(writerDir, ["config", "user.name", "Writer"]);
  await writeFile(path.join(writerDir, "remote.txt"), "from remote\n");
  await git(writerDir, ["add", "remote.txt"]);
  await git(writerDir, ["commit", "-m", "remote change"]);
  await git(writerDir, ["push", "origin", "main"]);

  // Local, unpushed commit -- local and origin/main have now diverged.
  await writeFile(path.join(workDir, "local.txt"), "from local\n");
  await git(workDir, ["add", "local.txt"]);
  await git(workDir, ["commit", "-m", "local change"]);
}

// Regression coverage for two of the originally reported problems: (1) /sync
// used to refuse outright on genuine divergence (DivergedBranchError),
// forcing a manual /merge -- Intelligent Sync Engine now reconciles
// automatically per the configured divergence strategy, journaling the
// delegated Rebase as a real, auditable Operation Journal entry; and (2)
// mutating commands had no shared awareness of "a merge is already in
// progress" -- Command Orchestrator now recommends recovery uniformly,
// through Automatic Safety Policies + Recovery Planner, for every operation
// (except fetch) rather than each workflow re-discovering the problem on
// its own.
describe("Git Orchestration: real-repo integration", () => {
  let workDir: string;
  let originDir: string;
  let writerDir: string;
  let journalDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "git-orch-work-"));
    originDir = await mkdtemp(path.join(tmpdir(), "git-orch-origin-"));
    writerDir = await mkdtemp(path.join(tmpdir(), "git-orch-writer-"));
    journalDir = await mkdtemp(path.join(tmpdir(), "git-orch-journal-"));
  });

  afterEach(async () => {
    await Promise.all([workDir, originDir, writerDir, journalDir].map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("auto-reconciles a diverged sync via rebase, and journals it", async () => {
    await setupDivergedRepo(workDir, originDir, writerDir);

    const repository: Repository = { id: "repo-1", name: "repo-1", path: workDir, defaultBranch: "main", active: true };
    const registry = fakeRegistry(repository);
    const snapshotService = new RepositorySnapshotService(registry);
    const journal = createOperationJournal(journalDir);
    const transactionManager = new GitTransactionManager(snapshotService, journal, registry);
    const conflictResolutionEngine = new ConflictResolutionEngine(registry, alwaysApprove);
    const rebaseEngine = new RebaseEngine(registry, transactionManager, conflictResolutionEngine);
    const mergeEngine = new MergeEngine(registry, transactionManager, conflictResolutionEngine);
    const safetyPolicies = new AutomaticSafetyPolicies(fakeConfigService("rebase"));
    const syncEngine = new IntelligentSyncEngine(registry, transactionManager, safetyPolicies, alwaysApprove, rebaseEngine, mergeEngine);

    const outcome = await syncEngine.sync("repo-1", "corr-1", new AbortController().signal);

    expect(outcome.kind).toBe("delegated");
    if (outcome.kind !== "delegated") throw new Error("expected delegated");
    expect(outcome.to).toBe("rebase");
    expect(outcome.outcome.kind).toBe("completed");

    // Both the local and the remote change must now be present, in a linear
    // history (a rebase, not a merge commit).
    const files = await git(workDir, ["ls-files"]);
    expect(files.split("\n").sort()).toEqual(["base.txt", "local.txt", "remote.txt"]);
    const logGraph = await git(workDir, ["log", "--oneline"]);
    expect(logGraph.split("\n")).toHaveLength(3);

    // The Rebase Engine's own Transaction must have journaled a real,
    // queryable, Completed entry -- the audit trail the original design had
    // no equivalent of.
    const entries = await journal.query({ repositoryId: "repo-1", operation: JournalOperationType.Rebase });
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe(JournalEntryStatus.Completed);
    expect(entries[0].rollbackStrategy).toBe("reset-hard");
  });

  // Regression coverage for the double-approval / no-approval bug: this
  // delegated call used to skip Command Orchestrator/Automatic Safety
  // Policies entirely, so the default (Rebase) divergence strategy silently
  // rewrote local history with zero approval prompt -- contradicting
  // IntelligentSyncEngine's own doc comment (and AutomaticSafetyPolicies'
  // HARDCODED_APPROVAL_OPERATIONS comment) that rebase is "always
  // approval-gated regardless of context." Declining approval must now
  // leave the repository exactly as it was before sync ran.
  it("requests approval before rebase-reconciling a diverged sync (default strategy), and honors a decline", async () => {
    await setupDivergedRepo(workDir, originDir, writerDir);

    const repository: Repository = { id: "repo-1", name: "repo-1", path: workDir, defaultBranch: "main", active: true };
    const registry = fakeRegistry(repository);
    const snapshotService = new RepositorySnapshotService(registry);
    const journal = createOperationJournal(journalDir);
    const transactionManager = new GitTransactionManager(snapshotService, journal, registry);
    const conflictResolutionEngine = new ConflictResolutionEngine(registry, alwaysApprove);
    const rebaseEngine = new RebaseEngine(registry, transactionManager, conflictResolutionEngine);
    const mergeEngine = new MergeEngine(registry, transactionManager, conflictResolutionEngine);
    const safetyPolicies = new AutomaticSafetyPolicies(fakeConfigService("rebase"));
    const decliningGate = countingApprovalGate(false);
    const syncEngine = new IntelligentSyncEngine(registry, transactionManager, safetyPolicies, decliningGate, rebaseEngine, mergeEngine);

    const outcome = await syncEngine.sync("repo-1", "corr-1", new AbortController().signal);

    expect(decliningGate.calls).toBe(1);
    expect(outcome.kind).toBe("declined");

    // No rebase happened: only the local commit is present, nothing rewritten.
    const logGraph = await git(workDir, ["log", "--oneline"]);
    expect(logGraph.split("\n")).toHaveLength(2);
    const entries = await journal.query({ repositoryId: "repo-1", operation: JournalOperationType.Rebase });
    expect(entries).toHaveLength(0);
  });

  it("requests approval before merge-reconciling a diverged sync (merge strategy), and proceeds once approved", async () => {
    await setupDivergedRepo(workDir, originDir, writerDir);

    const repository: Repository = { id: "repo-1", name: "repo-1", path: workDir, defaultBranch: "main", active: true };
    const registry = fakeRegistry(repository);
    const snapshotService = new RepositorySnapshotService(registry);
    const journal = createOperationJournal(journalDir);
    const transactionManager = new GitTransactionManager(snapshotService, journal, registry);
    const conflictResolutionEngine = new ConflictResolutionEngine(registry, alwaysApprove);
    const rebaseEngine = new RebaseEngine(registry, transactionManager, conflictResolutionEngine);
    const mergeEngine = new MergeEngine(registry, transactionManager, conflictResolutionEngine);
    const safetyPolicies = new AutomaticSafetyPolicies(fakeConfigService("merge"));
    const approvingGate = countingApprovalGate(true);
    const syncEngine = new IntelligentSyncEngine(registry, transactionManager, safetyPolicies, approvingGate, rebaseEngine, mergeEngine);

    const outcome = await syncEngine.sync("repo-1", "corr-1", new AbortController().signal);

    expect(approvingGate.calls).toBe(1);
    expect(outcome.kind).toBe("delegated");
    if (outcome.kind !== "delegated") throw new Error("expected delegated");
    expect(outcome.to).toBe("merge");
    expect(outcome.outcome.kind).toBe("merged");
  });

  it("declines to merge-reconcile a diverged sync (merge strategy) without approval, and leaves history untouched", async () => {
    await setupDivergedRepo(workDir, originDir, writerDir);

    const repository: Repository = { id: "repo-1", name: "repo-1", path: workDir, defaultBranch: "main", active: true };
    const registry = fakeRegistry(repository);
    const snapshotService = new RepositorySnapshotService(registry);
    const journal = createOperationJournal(journalDir);
    const transactionManager = new GitTransactionManager(snapshotService, journal, registry);
    const conflictResolutionEngine = new ConflictResolutionEngine(registry, alwaysApprove);
    const rebaseEngine = new RebaseEngine(registry, transactionManager, conflictResolutionEngine);
    const mergeEngine = new MergeEngine(registry, transactionManager, conflictResolutionEngine);
    const safetyPolicies = new AutomaticSafetyPolicies(fakeConfigService("merge"));
    const syncEngine = new IntelligentSyncEngine(registry, transactionManager, safetyPolicies, alwaysDecline, rebaseEngine, mergeEngine);

    const outcome = await syncEngine.sync("repo-1", "corr-1", new AbortController().signal);

    expect(outcome.kind).toBe("declined");
    const logGraph = await git(workDir, ["log", "--oneline"]);
    expect(logGraph.split("\n")).toHaveLength(2);
    const entries = await journal.query({ repositoryId: "repo-1", operation: JournalOperationType.Merge });
    expect(entries).toHaveLength(0);
  });

  it("recommends recovery instead of attempting a commit into an in-progress merge, then Repository Recovery Workflow resolves it", async () => {
    await git(workDir, ["init", "-b", "main"]);
    await git(workDir, ["config", "user.email", "test@example.com"]);
    await git(workDir, ["config", "user.name", "Test"]);
    await writeFile(path.join(workDir, "shared.txt"), "a\n");
    await git(workDir, ["add", "shared.txt"]);
    await git(workDir, ["commit", "-m", "init"]);

    await git(workDir, ["checkout", "-b", "feature"]);
    await writeFile(path.join(workDir, "shared.txt"), "b\n");
    await git(workDir, ["commit", "-am", "feature change"]);

    await git(workDir, ["checkout", "main"]);
    await writeFile(path.join(workDir, "shared.txt"), "c\n");
    await git(workDir, ["commit", "-am", "main change"]);

    // Provoke a real merge conflict and leave it mid-flight, exactly as an
    // interrupted/abandoned manual merge would.
    await execFileAsync("git", ["merge", "feature"], { cwd: workDir }).catch(() => undefined);

    const repository: Repository = { id: "repo-1", name: "repo-1", path: workDir, defaultBranch: "main", active: true };
    const registry = fakeRegistry(repository);
    const journal = createOperationJournal(journalDir);
    const healthService = new GitHealthService(registry, journal);
    const stateAnalyzer = new RepositoryStateAnalyzer();
    const preflightPolicy = new PreflightValidationPolicy();
    const safetyPolicies = new AutomaticSafetyPolicies(fakeConfigService());
    const recoveryPlanner = new RecoveryPlanner(stateAnalyzer);
    const orchestrator = new CommandOrchestrator(
      healthService,
      safetyPolicies,
      preflightPolicy,
      recoveryPlanner,
      alwaysApprove,
      stateAnalyzer,
      new GitStateMachine(),
    );

    const health = await healthService.getHealth("repo-1");
    expect(health.inProgressOperation?.kind).toBe("merge");

    let ran = false;
    const result = await orchestrator.execute({
      operation: JournalOperationType.Commit,
      repositoryId: "repo-1",
      correlationId: "corr-1",
      input: { message: "should never run" },
      run: async () => {
        ran = true;
      },
    });

    expect(ran).toBe(false);
    expect(result.kind).toBe("recommend-recovery");
    if (result.kind !== "recommend-recovery") throw new Error("expected recommend-recovery");
    expect(result.plan.detectedState).toBe(RepositoryState.MergeInProgress);
    expect(result.plan.steps).toEqual([expect.objectContaining({ command: { kind: "abort-merge" } })]);

    const recoveryWorkflow = new RepositoryRecoveryWorkflow(registry, healthService, stateAnalyzer, alwaysApprove);
    const outcome = await recoveryWorkflow.execute(result.plan, new AbortController().signal);

    expect(outcome.stoppedAtStep).toBeUndefined();
    expect(outcome.finalState).toBe(RepositoryState.Clean);

    const finalHealth = await healthService.getHealth("repo-1");
    expect(finalHealth.inProgressOperation).toBeUndefined();

    // The commit that /commit would have made is now safe to attempt for
    // real, exactly the flow /recover -> /commit is meant to enable.
    const gitAdapter = new GitAdapter(registry, "repo-1");
    const status = await gitAdapter.status();
    expect(status.isClean).toBe(true);
  });
});
