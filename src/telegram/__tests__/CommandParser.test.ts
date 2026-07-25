import { describe, expect, it } from "vitest";
import { MAX_HISTORY_LIMIT } from "../../git/GitConstants";
import { CommandParser } from "../CommandParser";
import { CommandParseError } from "../errors";

// Regression coverage for the Git History & Inspection System's new command
// surface (/history, /show, /diff, the redesigned /undo, and /task history)
// -- CommandParser had no dedicated test file before this feature; scoped to
// what this feature actually added/changed, not a full audit of every
// pre-existing command.
describe("CommandParser: Git History & Inspection System", () => {
  const parser = new CommandParser();

  describe("/history", () => {
    it("defaults to the default history limit with no filter", () => {
      const parsed = parser.parse("/history");
      expect(parsed).toEqual({ kind: "query", query: { type: "git-history", limit: 10 }, repositoryId: undefined });
    });

    it("accepts an explicit count", () => {
      const parsed = parser.parse("/history 5");
      expect(parsed).toEqual({ kind: "query", query: { type: "git-history", limit: 5 }, repositoryId: undefined });
    });

    it(`clamps a count above the maximum (${MAX_HISTORY_LIMIT}) rather than rejecting it`, () => {
      const parsed = parser.parse("/history 999");
      expect(parsed).toEqual({ kind: "query", query: { type: "git-history", limit: MAX_HISTORY_LIMIT }, repositoryId: undefined });
    });

    it("rejects a non-numeric, non-filter argument", () => {
      expect(() => parser.parse("/history abc")).toThrow(CommandParseError);
    });

    it("rejects a zero or negative count", () => {
      expect(() => parser.parse("/history 0")).toThrow(CommandParseError);
      expect(() => parser.parse("/history -5")).toThrow(CommandParseError);
    });

    it("parses a branch: filter", () => {
      const parsed = parser.parse("/history branch:main");
      expect(parsed).toEqual({ kind: "query", query: { type: "git-history", branch: "main" }, repositoryId: undefined });
    });

    it("parses an author: filter, case-insensitive prefix, case-preserving value", () => {
      const parsed = parser.parse("/history Author:Taijul");
      expect(parsed).toEqual({ kind: "query", query: { type: "git-history", author: "Taijul" }, repositoryId: undefined });
    });

    it("parses a search: filter", () => {
      const parsed = parser.parse("/history search:telegram");
      expect(parsed).toEqual({ kind: "query", query: { type: "git-history", search: "telegram" }, repositoryId: undefined });
    });

    it("rejects an empty branch:/author:/search: value", () => {
      expect(() => parser.parse("/history branch:")).toThrow(CommandParseError);
      expect(() => parser.parse("/history author:")).toThrow(CommandParseError);
      expect(() => parser.parse("/history search:")).toThrow(CommandParseError);
    });

    it("recognizes a trailing repo= override without absorbing it into the branch value", () => {
      const parsed = parser.parse("/history branch:main repo=test-ai-controller");
      expect(parsed).toEqual({
        kind: "query",
        query: { type: "git-history", branch: "main" },
        repositoryId: "test-ai-controller",
      });
    });
  });

  describe("/show", () => {
    it("parses a commit hash", () => {
      const parsed = parser.parse("/show 6739c2e");
      expect(parsed).toEqual({ kind: "query", query: { type: "git-show", hash: "6739c2e" }, repositoryId: undefined });
    });

    it("requires a hash", () => {
      expect(() => parser.parse("/show")).toThrow(CommandParseError);
    });

    it("takes only the first token as the hash", () => {
      const parsed = parser.parse("/show 6739c2e extra text");
      expect(parsed).toEqual({ kind: "query", query: { type: "git-show", hash: "6739c2e" }, repositoryId: undefined });
    });
  });

  describe("/diff", () => {
    it("parses a commit hash", () => {
      const parsed = parser.parse("/diff 6739c2e");
      expect(parsed).toEqual({ kind: "query", query: { type: "git-diff", hash: "6739c2e" }, repositoryId: undefined });
    });

    it("requires a hash", () => {
      expect(() => parser.parse("/diff")).toThrow(CommandParseError);
    });
  });

  describe("/undo", () => {
    it("bare /undo carries no target", () => {
      const parsed = parser.parse("/undo");
      expect(parsed).toEqual({ kind: "query", query: { type: "undo" }, repositoryId: undefined });
    });

    it("/undo <hash> carries the hash as target", () => {
      const parsed = parser.parse("/undo 6739c2e");
      expect(parsed).toEqual({ kind: "query", query: { type: "undo", target: "6739c2e" }, repositoryId: undefined });
    });

    it("/undo confirm carries the literal 'confirm' as target", () => {
      const parsed = parser.parse("/undo confirm");
      expect(parsed).toEqual({ kind: "query", query: { type: "undo", target: "confirm" }, repositoryId: undefined });
    });
  });

  describe("/task history (renamed from the old bare /history)", () => {
    it("bare '/task history' carries no limit", () => {
      const parsed = parser.parse("/task history");
      expect(parsed).toEqual({ kind: "query", query: { type: "task-history" }, repositoryId: undefined });
    });

    it("'/task history <n>' carries the limit", () => {
      const parsed = parser.parse("/task history 5");
      expect(parsed).toEqual({ kind: "query", query: { type: "task-history", limit: 5 }, repositoryId: undefined });
    });

    it("rejects a non-numeric limit", () => {
      expect(() => parser.parse("/task history abc")).toThrow(CommandParseError);
    });

    it("plain '/task' and '/task cancel' still work unaffected", () => {
      expect(parser.parse("/task")).toEqual({ kind: "query", query: { type: "task" }, repositoryId: undefined });
      expect(parser.parse("/task cancel")).toEqual({ kind: "query", query: { type: "task-cancel" }, repositoryId: undefined });
    });
  });

  it("repo= override still works for the new commands", () => {
    const parsed = parser.parse("/show 6739c2e repo=test-ai-controller");
    expect(parsed).toEqual({ kind: "query", query: { type: "git-show", hash: "6739c2e" }, repositoryId: "test-ai-controller" });
  });
});
