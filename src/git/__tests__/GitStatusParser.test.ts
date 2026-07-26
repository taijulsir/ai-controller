import { describe, expect, it } from "vitest";
import { parseWorkingTreeChanges } from "../GitStatusParser";

// Working Tree Management (/changes, /showchanges, /discard): pure,
// fixture-based coverage of every porcelain=v2 shape parseWorkingTreeChanges
// must classify correctly -- complements WorkingTreeService's own real-repo
// integration tests (src/git/__tests__/WorkingTreeService.test.ts) with the
// precise, hard-to-reliably-reproduce-via-real-git edge cases (mixed
// staged+unstaged status on the same path, rename records).
describe("parseWorkingTreeChanges", () => {
  it("returns an empty list for a clean tree", () => {
    expect(parseWorkingTreeChanges("# branch.head main\n# branch.ab +0 -0\n")).toEqual([]);
  });

  it("classifies an unstaged-modified tracked file", () => {
    const changes = parseWorkingTreeChanges("1 .M N... 100644 100644 100644 abc123 abc123 src/foo.ts\n");
    expect(changes).toEqual([{ index: 1, path: "src/foo.ts", status: "modified", staged: false, unstaged: true }]);
  });

  it("classifies a staged-modified tracked file", () => {
    const changes = parseWorkingTreeChanges("1 M. N... 100644 100644 100644 abc123 abc123 src/foo.ts\n");
    expect(changes).toEqual([{ index: 1, path: "src/foo.ts", status: "modified", staged: true, unstaged: false }]);
  });

  it("classifies a file both staged and further modified (mixed XY) as modified, staged and unstaged both true", () => {
    const changes = parseWorkingTreeChanges("1 MM N... 100644 100644 100644 abc123 abc123 src/foo.ts\n");
    expect(changes).toEqual([{ index: 1, path: "src/foo.ts", status: "modified", staged: true, unstaged: true }]);
  });

  it("classifies a staged-added file", () => {
    const changes = parseWorkingTreeChanges("1 A. N... 000000 100644 100644 0000000 abc123 src/new.ts\n");
    expect(changes).toEqual([{ index: 1, path: "src/new.ts", status: "added", staged: true, unstaged: false }]);
  });

  it("classifies a deleted file (staged and unstaged variants)", () => {
    const staged = parseWorkingTreeChanges("1 D. N... 100644 000000 000000 abc123 0000000 src/gone.ts\n");
    expect(staged).toEqual([{ index: 1, path: "src/gone.ts", status: "deleted", staged: true, unstaged: false }]);

    const unstaged = parseWorkingTreeChanges("1 .D N... 100644 100644 000000 abc123 abc123 src/gone.ts\n");
    expect(unstaged).toEqual([{ index: 1, path: "src/gone.ts", status: "deleted", staged: false, unstaged: true }]);
  });

  it("classifies a staged rename, carrying the original path", () => {
    const changes = parseWorkingTreeChanges("2 R. N... 100644 100644 100644 abc123 abc123 R100 src/new-name.ts\tsrc/old-name.ts\n");
    expect(changes).toEqual([
      { index: 1, path: "src/new-name.ts", status: "renamed", staged: true, unstaged: false, renamedFrom: "src/old-name.ts" },
    ]);
  });

  it("classifies an untracked file with neither staged nor unstaged set", () => {
    const changes = parseWorkingTreeChanges("? src/brand-new.ts\n");
    expect(changes).toEqual([{ index: 1, path: "src/brand-new.ts", status: "untracked", staged: false, unstaged: false }]);
  });

  it("classifies an unmerged (conflicted) path as modified, both staged and unstaged", () => {
    const changes = parseWorkingTreeChanges("u UU N... 100644 100644 100644 100644 abc abc abc src/conflict.ts\n");
    expect(changes).toEqual([{ index: 1, path: "src/conflict.ts", status: "modified", staged: true, unstaged: true }]);
  });

  it("assigns a stable, sequential index across mixed entry types in the order git reports them", () => {
    const output = [
      "# branch.head main",
      "1 M. N... 100644 100644 100644 abc abc src/a.ts",
      "1 .M N... 100644 100644 100644 abc abc src/b.ts",
      "? src/c.ts",
      "2 R. N... 100644 100644 100644 abc abc R100 src/e.ts\tsrc/d.ts",
    ].join("\n");
    const changes = parseWorkingTreeChanges(output);
    expect(changes.map((change) => [change.index, change.path])).toEqual([
      [1, "src/a.ts"],
      [2, "src/b.ts"],
      [3, "src/c.ts"],
      [4, "src/e.ts"],
    ]);
  });

  it("ignores branch header lines entirely", () => {
    const changes = parseWorkingTreeChanges("# branch.head main\n# branch.ab +2 -1\n1 M. N... 100644 100644 100644 abc abc src/a.ts\n");
    expect(changes).toHaveLength(1);
  });
});
