import { beforeEach, describe, expect, it } from "vitest";
import {
  buildDiffNotesPrompt,
  describeSelection,
  firstNoteLine,
  noteRows,
  PROMPT_CHAR_CAP,
  QUOTE_LINE_CAP,
  rangeLines,
  slotLine,
  type DiffNote,
} from "../../lib/agents/diffNotes";
import { parseUnifiedDiff, type DiffLine } from "../../lib/viewers/diff";
import { enSource } from "../../lib/i18n/en";
import { useDiffNotesStore } from "../../stores/agents/diffNotes";
import { useTabsStore } from "../../stores/tabs";

const t = (key: string, params?: Record<string, string | number>) =>
  (enSource as Record<string, string>)[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name]));

const lines = (diff: string): DiffLine[] => parseUnifiedDiff(diff).flatMap((file) => file.hunks).flatMap((hunk) => hunk.lines);

// A hunk's lines start with its `@@` line. Indices: 0 header, 1 keep (40),
// 2 old1 (41), 3 old2 (42), 4 new1 (41), 5 new2 (42), 6 new3 (43), 7 tail (44).
const REPLACE = lines("@@ -40,4 +40,5 @@\n keep\n-old1\n-old2\n+new1\n+new2\n+new3\n tail\n");

function note(over: Partial<DiffNote> = {}): DiffNote {
  return {
    id: "n1", path: "src/a.ts", side: "new", from: 42, to: 44, quote: ["+ one", "+ two"], text: "Fix this.", at: 1,
    card: "c", hunk: 0, lines: [4, 5], ...over,
  };
}

describe("describeSelection", () => {
  it("describes added lines on the new side, with their markers", () => {
    expect(describeSelection(REPLACE, [4, 5])).toEqual({ side: "new", from: 41, to: 42, quote: ["+ new1", "+ new2"] });
  });

  it("uses the old side only when every line is a deletion", () => {
    expect(describeSelection(REPLACE, [2, 3])).toEqual({ side: "old", from: 41, to: 42, quote: ["- old1", "- old2"] });
    expect(describeSelection(REPLACE, [2])).toEqual({ side: "old", from: 41, to: 41, quote: ["- old1"] });
  });

  it("takes new-side numbers from the numbered lines of a mixed range, quoting the deletions too", () => {
    expect(describeSelection(REPLACE, [1, 2, 4])).toEqual({
      side: "new", from: 40, to: 41, quote: ["  keep", "- old1", "+ new1"],
    });
  });

  it("is null for a header or nothing", () => {
    expect(describeSelection(REPLACE, [])).toBeNull();
    expect(describeSelection(REPLACE, [0])).toBeNull();
  });
});

describe("rows and ranges", () => {
  it("has one unified row per body line, none for the header", () => {
    expect(noteRows(REPLACE, false)).toEqual([[1], [2], [3], [4], [5], [6], [7]]);
  });

  it("pairs a replacement's deletions with its additions when split", () => {
    expect(noteRows(REPLACE, true)).toEqual([[1], [2, 4], [3, 5], [6], [7]]);
  });

  it("extends a range across rows, either way round", () => {
    const rows = noteRows(REPLACE, false);
    expect(rangeLines(rows, 2, 5)).toEqual([2, 3, 4, 5]);
    expect(rangeLines(rows, 5, 2)).toEqual([2, 3, 4, 5]);
    expect(rangeLines(rows, 99, 3)).toEqual([3]);
    expect(rangeLines(rows, 3, 99)).toEqual([]);
  });

  it("extends over split rows with every line they show", () => {
    expect(rangeLines(noteRows(REPLACE, true), 2, 3)).toEqual([2, 3, 4, 5]);
  });

  it("hangs a note under the last row it touches", () => {
    expect(slotLine(noteRows(REPLACE, false), [2, 3])).toBe(3);
    const split = noteRows(REPLACE, true);
    expect(slotLine(split, [2, 3, 4, 5])).toBe(3);
    expect(slotLine(split, [42])).toBeNull();
  });

  it("starts on the first changed line", () => {
    expect(firstNoteLine(REPLACE)).toBe(2);
    expect(firstNoteLine(lines("@@ -1,1 +1,1 @@\n same\n"))).toBe(1);
    expect(firstNoteLine([])).toBe(-1);
  });
});

describe("buildDiffNotesPrompt", () => {
  it("builds the plan's prompt for an added range and a removed one", () => {
    const { text, omitted } = buildDiffNotesPrompt([
      note({ quote: ["+ const limit = opts.limit ?? 10;", "+ if (items.length > limit) {", "+   items.length = limit;"], text: "Don't mutate the caller's array; slice instead.", path: "src/lib/foo.ts" }),
      note({ id: "n2", path: "src/lib/bar.ts", side: "old", from: 12, to: 13, quote: ["- // keep in sync with baz.ts", "- export const SIZE = 4;"], text: "baz.ts still imports SIZE." }),
    ], t);
    expect(omitted).toBe(0);
    expect(text).toBe([
      "Review notes on your changes:",
      "",
      "src/lib/foo.ts:42-44",
      "```diff",
      "+ const limit = opts.limit ?? 10;",
      "+ if (items.length > limit) {",
      "+   items.length = limit;",
      "```",
      "→ Don't mutate the caller's array; slice instead.",
      "",
      "src/lib/bar.ts (removed lines 12-13)",
      "```diff",
      "- // keep in sync with baz.ts",
      "- export const SIZE = 4;",
      "```",
      "→ baz.ts still imports SIZE.",
    ].join("\n"));
  });

  it("names a single line without a range", () => {
    const { text } = buildDiffNotesPrompt([note({ from: 7, to: 7, quote: ["+ x"] }), note({ id: "n2", side: "old", from: 3, to: 3, quote: ["- y"] })], t);
    expect(text).toContain("src/a.ts:7\n");
    expect(text).toContain("src/a.ts (removed line 3)\n");
  });

  it("groups notes by file in first-noted order", () => {
    const { included } = buildDiffNotesPrompt([
      note({ id: "a1", path: "a.ts" }), note({ id: "b1", path: "b.ts" }), note({ id: "a2", path: "a.ts" }),
    ], t);
    expect(included.map((n) => n.id)).toEqual(["a1", "a2", "b1"]);
  });

  it("cuts a long quote after the cap and counts what it left out", () => {
    const quote = Array.from({ length: QUOTE_LINE_CAP + 3 }, (_, i) => `+ line ${i}`);
    const { text } = buildDiffNotesPrompt([note({ quote })], t);
    expect(text).toContain(`+ line ${QUOTE_LINE_CAP - 1}\n… (3 more lines)\n\`\`\``);
    expect(text).not.toContain(`+ line ${QUOTE_LINE_CAP}\n`);
  });

  it("fences a quote that holds a fence with a longer one", () => {
    const { text } = buildDiffNotesPrompt([note({ quote: ["+ ```ts", "+ x", "+ ```"] })], t);
    expect(text).toContain("````diff\n+ ```ts\n+ x\n+ ```\n````\n→ Fix this.");
  });

  it("keeps the whole prompt within the cap, reporting the notes left out", () => {
    const big = (id: string) => note({ id, text: "x".repeat(3000) });
    const { text, included, omitted } = buildDiffNotesPrompt([big("a"), big("b"), big("c")], t);
    expect(text.length).toBeLessThanOrEqual(PROMPT_CHAR_CAP);
    expect(included.map((n) => n.id)).toEqual(["a", "b"]);
    expect(omitted).toBe(1);
  });

  it("always takes the first note, however long", () => {
    const { included, omitted } = buildDiffNotesPrompt([note({ text: "y".repeat(PROMPT_CHAR_CAP + 10) }), note({ id: "n2" })], t);
    expect(included).toHaveLength(1);
    expect(omitted).toBe(1);
  });

  it("keeps the lines of a multi-line note", () => {
    expect(buildDiffNotesPrompt([note({ text: "  first\nsecond  " })], t).text).toMatch(/→ first\nsecond$/u);
  });
});

describe("the diff notes store", () => {
  beforeEach(() => {
    useDiffNotesStore.setState({ byTab: {} });
  });

  it("adds, edits, removes and clears per tab", () => {
    const s = useDiffNotesStore.getState();
    s.add("p:a", note({ id: "1" }));
    s.add("p:a", note({ id: "2" }));
    s.add("p:b", note({ id: "3" }));
    s.update("p:a", "2", { text: "Changed" });
    expect(useDiffNotesStore.getState().byTab["p:a"].map((n) => n.text)).toEqual(["Fix this.", "Changed"]);
    s.remove("p:a", "1");
    expect(useDiffNotesStore.getState().byTab["p:a"].map((n) => n.id)).toEqual(["2"]);
    s.removeMany("p:b", ["3"]);
    expect(useDiffNotesStore.getState().byTab["p:b"]).toBeUndefined();
    s.clear("p:a");
    expect(useDiffNotesStore.getState().byTab).toEqual({});
  });

  it("drops a closed tab's notes and leaves a scope it holds no tabs of alone", () => {
    const tab = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent" as const };
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [tab] } }));
    useDiffNotesStore.getState().add("p:agent-1", note({ id: "1" }));
    useDiffNotesStore.getState().add("q:agent-9", note({ id: "2" }));
    useTabsStore.setState((state) => ({ ...state, tabsByScope: { p: [] } }));
    expect(Object.keys(useDiffNotesStore.getState().byTab)).toEqual(["q:agent-9"]);
  });
});
