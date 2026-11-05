/**
 * Unit tests for the pure line-diff/merge logic behind the three-column compare
 * view: `diffLines` alignment, `groupChanges` blocking, `buildMerged` assembly,
 * and the context-anchored `locateBlock`/`applyBlockToggle` splice used to edit a
 * hand-edited merge buffer. Mirrors the `diff.ts` test style.
 */
import { describe, it, expect } from "vitest";
import {
  diffLines,
  groupChanges,
  buildMerged,
  locateBlock,
  applyBlockToggle,
  canToggle,
  blockSideLines,
  type Decision,
} from "../../lib/viewers/linediff";

describe("diffLines", () => {
  it("marks identical text as all-same", () => {
    const rows = diffLines("a\nb\nc", "a\nb\nc");
    expect(rows.every((r) => r.kind === "same")).toBe(true);
    expect(rows.map((r) => r.right)).toEqual(["a", "b", "c"]);
  });

  it("pairs a replaced line as a change row", () => {
    const rows = diffLines("a\nb\nc", "a\nB\nc");
    expect(rows.map((r) => r.kind)).toEqual(["same", "change", "same"]);
    expect(rows[1]).toEqual({ left: "b", right: "B", kind: "change" });
  });

  it("represents a pure insertion as an add row", () => {
    const rows = diffLines("a\nc", "a\nb\nc");
    const add = rows.find((r) => r.kind === "add");
    expect(add).toEqual({ left: null, right: "b", kind: "add" });
  });

  it("represents a pure deletion as a del row", () => {
    const rows = diffLines("a\nb\nc", "a\nc");
    const del = rows.find((r) => r.kind === "del");
    expect(del).toEqual({ left: "b", right: null, kind: "del" });
  });
});

describe("groupChanges", () => {
  it("collapses consecutive non-same rows into one block with context", () => {
    const rows = diffLines("a\nb\nc\nd", "a\nX\nY\nd");
    const blocks = groupChanges(rows);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].oldLines).toEqual(["b", "c"]);
    expect(blocks[0].newLines).toEqual(["X", "Y"]);
    expect(blocks[0].contextBefore).toEqual(["a"]);
    expect(blocks[0].contextAfter).toEqual(["d"]);
  });

  it("separates changes divided by unchanged lines into distinct blocks", () => {
    const rows = diffLines("a\nb\nc\nd\ne", "A\nb\nc\nd\nE");
    const blocks = groupChanges(rows);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].id).toBe(0);
    expect(blocks[1].id).toBe(1);
  });
});

describe("buildMerged", () => {
  const oldText = "a\nb\nc\nd";
  const newText = "a\nX\nY\nd";
  const rows = diffLines(oldText, newText);
  const blocks = groupChanges(rows);

  it("all-accepted reproduces the new text", () => {
    expect(buildMerged(rows, blocks, {})).toBe(newText);
  });

  it("all-rejected reproduces the old text", () => {
    const decisions: Record<number, Decision> = { 0: "reject" };
    expect(buildMerged(rows, blocks, decisions)).toBe(oldText);
  });
});

describe("locateBlock / applyBlockToggle", () => {
  const oldText = "top\na\nb\nc\np\nq\nr\ns\nbottom";
  const newText = "top\na\nX\nc\np\nq\nr\ns\nbottom";
  const rows = diffLines(oldText, newText);
  const blocks = groupChanges(rows);
  const block = blocks[0];

  it("locates the accepted side in the merge buffer", () => {
    const loc = locateBlock(newText.split("\n"), block, "accept");
    expect(loc).not.toBeNull();
    // the "X" line sits at index 2 in the new text
    expect(loc).toEqual({ start: 2, len: 1 });
  });

  it("toggles accept → reject by splicing old lines back in", () => {
    const res = applyBlockToggle(newText, block, "accept");
    expect(res).not.toBeNull();
    expect(res!.decision).toBe("reject");
    expect(res!.text).toBe(oldText);
  });

  it("preserves an unrelated manual edit while toggling", () => {
    const edited = newText.replace("bottom", "bottom-edited");
    const res = applyBlockToggle(edited, block, "accept");
    expect(res).not.toBeNull();
    expect(res!.text).toBe(oldText.replace("bottom", "bottom-edited"));
  });

  it("disables the toggle when the changed line is ambiguous with no context", () => {
    // A one-line change with no surrounding context (`a` → `X`), then a merge
    // buffer where "X" appears twice — the block can't be located uniquely.
    const b = groupChanges(diffLines("a", "X"))[0];
    expect(b.contextBefore).toEqual([]);
    expect(b.newLines).toEqual(["X"]);
    const ambiguous = "X\nfoo\nX";
    expect(canToggle(ambiguous, b, "accept")).toBe(false);
    expect(applyBlockToggle(ambiguous, b, "accept")).toBeNull();
  });
});

describe("blockSideLines", () => {
  it("numbers each block's lines per side, 1-based", () => {
    const rows = diffLines("a\nb\nc\nd\ne", "a\nX\nc\nd\nE\nF");
    const blocks = groupChanges(rows);
    expect(blockSideLines(rows, blocks)).toEqual([
      { left: [2], right: [2] },
      { left: [5], right: [5, 6] },
    ]);
  });

  it("leaves the absent side empty for a pure insertion or deletion", () => {
    const ins = diffLines("a\nc", "a\nb\nc");
    expect(blockSideLines(ins, groupChanges(ins))).toEqual([{ left: [], right: [2] }]);
    const del = diffLines("a\nb\nc", "a\nc");
    expect(blockSideLines(del, groupChanges(del))).toEqual([{ left: [2], right: [] }]);
  });

  it("gives nothing for identical texts", () => {
    const rows = diffLines("a\nb", "a\nb");
    expect(blockSideLines(rows, groupChanges(rows))).toEqual([]);
  });
});
