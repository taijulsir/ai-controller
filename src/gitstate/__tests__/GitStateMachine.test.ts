import { describe, expect, it } from "vitest";
import { GitStateMachine } from "../GitStateMachine";
import { IllegalStateTransitionError } from "../errors";
import { RepositoryState } from "../types";

describe("GitStateMachine", () => {
  const machine = new GitStateMachine();

  it("allows Clean to transition into every in-progress/dirty/diverged/detached/recovering state", () => {
    for (const target of [
      RepositoryState.Dirty,
      RepositoryState.Diverged,
      RepositoryState.MergeInProgress,
      RepositoryState.RebaseInProgress,
      RepositoryState.CherryPickInProgress,
      RepositoryState.RevertInProgress,
      RepositoryState.BisectInProgress,
      RepositoryState.DetachedHead,
      RepositoryState.Recovering,
    ]) {
      expect(machine.canTransition(RepositoryState.Clean, target)).toBe(true);
    }
  });

  it("rejects Clean transitioning directly to Unrecoverable", () => {
    expect(machine.canTransition(RepositoryState.Clean, RepositoryState.Unrecoverable)).toBe(false);
  });

  it("allows every in-progress state to resolve back to Clean or into Recovering", () => {
    for (const state of [
      RepositoryState.MergeInProgress,
      RepositoryState.RebaseInProgress,
      RepositoryState.CherryPickInProgress,
      RepositoryState.RevertInProgress,
      RepositoryState.BisectInProgress,
    ]) {
      expect(machine.canTransition(state, RepositoryState.Clean)).toBe(true);
      expect(machine.canTransition(state, RepositoryState.Recovering)).toBe(true);
    }
  });

  it("only Recovering has a legal path to Unrecoverable", () => {
    expect(machine.canTransition(RepositoryState.Recovering, RepositoryState.Unrecoverable)).toBe(true);
    for (const state of Object.values(RepositoryState)) {
      if (state === RepositoryState.Recovering) continue;
      expect(machine.canTransition(state, RepositoryState.Unrecoverable)).toBe(false);
    }
  });

  it("treats Unrecoverable as terminal -- no legal next states at all", () => {
    expect(machine.legalNextStates(RepositoryState.Unrecoverable)).toEqual([]);
  });

  it("assertTransition throws IllegalStateTransitionError for an illegal move", () => {
    expect(() => machine.assertTransition(RepositoryState.Dirty, RepositoryState.MergeInProgress)).toThrow(
      IllegalStateTransitionError,
    );
  });

  it("assertTransition does not throw for a legal move", () => {
    expect(() => machine.assertTransition(RepositoryState.Dirty, RepositoryState.Clean)).not.toThrow();
  });
});
