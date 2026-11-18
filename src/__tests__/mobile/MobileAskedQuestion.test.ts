import { describe, expect, it } from "vitest";
import type { AskedQuestion, TranscriptEntry } from "../../../mobile-web/src/api";
import { entryCardAllowed, mergeAskedQuestion, waitingQuestion, type LiveDialog } from "../../../mobile-web/src/terminal/askedQuestion";
import { readableScreen, type ReadableBufferLike } from "../../../mobile-web/src/terminal/readableScreen";
import { freeTextRow, selectSignature } from "../../../mobile-web/src/terminal/selectPrompt";
import { answerKeys, readReaderLive } from "../../lib/agents/readerLive";

function plainBuffer(rows: string[]): ReadableBufferLike {
  return { length: rows.length, getLine: (row) => (rows[row] === undefined ? undefined : { translateToString: () => rows[row] }) };
}

/** The probe's question (`tui_ask_multi`, Claude Code 2.1.327), as the stub model asked it. */
const ASKED: AskedQuestion[] = [
  { header: "Colours", question: "Which colours should the probe use?", multiSelect: true,
    options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }, { label: "Green", description: "calm" }] },
  { header: "Layout", question: "Which layout should the probe draw?",
    options: [{ label: "Grid", description: "rows and columns", preview: "+--+--+\n|  |  |\n+--+--+" }, { label: "List", description: "one column", preview: "- one\n- two" }] },
];
const ENTRY: TranscriptEntry = { kind: "answer", text: "Which colours should the probe use?", at: "2026-11-18T09:19:13.591Z", blocking: true, questions: ASKED };

/** Page 1 as the pane drew it: two boxes ticked, the highlight on Green. */
const MULTI_PAGE = [
  "❯ ask me things", "",
  "──────────────────────────────────────────────────────────────────────────────",
  "←  ☒ Colours  ☐ Layout  ✔ Submit  →",
  "Which colours should the probe use?",
  "  1. [✔] Red", "         warm",
  "  2. [✔] Blue", "         cool",
  "❯ 3. [ ] Green", "         calm",
  "  4. [ ] Type something", "     Next",
  "──────────────────────────────────────────────────────────────────────────────",
  "  5. Chat about this",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
];
const PREVIEW_PAGE = [
  "❯ ask me things", "",
  "──────────────────────────────────────────────────────────────────────────────",
  "←  ☒ Colours  ☐ Layout  ✔ Submit  →",
  "Which layout should the probe draw?",
  "❯ 1. Grid                         ┌──────────────────────────────────────────┐",
  "  2. List                         │ +--+--+                                  │",
  "                                  │ |  |  |                                  │",
  "                                  │ +--+--+                                  │",
  "                                  └──────────────────────────────────────────┘",
  "                                  Notes: press n to add notes",
  "──────────────────────────────────────────────────────────────────────────────",
  "  Chat about this",
  "Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel",
];
const REVIEW_PAGE = [
  "❯ ask me things", "",
  "←  ☒ Colours  ☒ Layout  ✔ Submit  →",
  "Review your answers",
  " ● Which colours should the probe use?", "   → Red, Blue", " ● Which layout should the probe draw?", "   → Grid",
  "❯ 1. Submit answers", "  2. Cancel",
];

function dialogOf(rows: string[]): LiveDialog | null {
  const live = readReaderLive(plainBuffer(rows), "Claude", 110);
  return live.question ? { question: live.question, ask: live.ask, context: live.context, tabs: live.tabs, tabFocus: live.tabFocus, tabSubmit: live.tabSubmit, tabKeys: live.tabKeys } : null;
}

describe("the waiting question entry", () => {
  it("is the last blocking entry with questions, and nothing else", () => {
    const answered: TranscriptEntry = { ...ENTRY, blocking: undefined };
    const codexAsync: TranscriptEntry = { ...ENTRY, blocking: undefined, asking: true };
    expect(waitingQuestion([ENTRY])).toBe(ENTRY);
    // A prompt the phone has sent and the session has not recorded comes after it.
    expect(waitingQuestion([{ kind: "prompt", text: "hi" }, ENTRY, { kind: "prompt", text: "more", pending: 3 }])).toBe(ENTRY);
    expect(waitingQuestion([answered])).toBeNull();
    expect(waitingQuestion([codexAsync])).toBeNull();
    expect(waitingQuestion([{ ...ENTRY, questions: [] }])).toBeNull();
    expect(waitingQuestion([])).toBeNull();
  });
});

describe("a waiting entry merged with the screen", () => {
  it("takes the content from the entry and the cursor and ticks from the screen", () => {
    const live = dialogOf(MULTI_PAGE);
    expect(live?.question.current).toBe(2);
    const card = mergeAskedQuestion(ENTRY, live);
    expect(card?.kind).toBe("merged");
    const options = card?.question.options ?? [];
    // The three answers: the entry's words, the screen's ticks and rows.
    expect(options.slice(0, 3).map((option) => [option.label, option.description, option.ticked, option.index, option.number])).toEqual([
      ["Red", "warm", true, 0, 1], ["Blue", "cool", true, 1, 2], ["Green", "calm", false, 2, 3],
    ]);
    // The rows only the screen has stay as it drew them.
    expect(options.slice(3).map((option) => option.label)).toEqual(["[ ] Type something", "Next", "Chat about this"]);
    expect(card?.question.current).toBe(2);
    expect(card?.question.multiSelect).toBe(true);
    expect(card?.question.source).toBe("entry");
    expect(card?.question.readOnly).toBeUndefined();
    expect(card?.ask).toEqual(["Which colours should the probe use?"]);
    expect(card?.tabs).toEqual(live?.tabs);
    expect(card?.signature).toBe(selectSignature(live!.question));
  });

  it("answers from the screen's reading: the same keys, the free-text row still words", () => {
    const live = dialogOf(MULTI_PAGE)!;
    const card = mergeAskedQuestion(ENTRY, live)!;
    for (const index of [0, 1, 2, 4, 5]) {
      const merged = card.question.options.find((option) => option.index === index)!;
      const screen = live.question.options.find((option) => option.index === index)!;
      expect(answerKeys(card.question, merged), `row ${index}`).toEqual(answerKeys(live.question, screen));
    }
    const typed = card.question.options.find((option) => option.index === 3)!;
    expect(freeTextRow(typed)).toBe(true);
    expect(answerKeys(card.question, typed)).toEqual([]);
  });

  it("puts the entry's preview on its row, and keeps its line breaks", () => {
    const live = dialogOf(PREVIEW_PAGE);
    expect(live?.question.options.map((option) => option.label)).toEqual(["Grid", "List", "Chat about this"]);
    const card = mergeAskedQuestion(ENTRY, live);
    expect(card?.kind).toBe("merged");
    expect(card?.question.options.slice(0, 2).map((option) => [option.label, option.description, option.preview])).toEqual([
      ["Grid", "rows and columns", "+--+--+\n|  |  |\n+--+--+"], ["List", "one column", "- one\n- two"],
    ]);
    expect(card?.question.multiSelect).toBeUndefined();
    expect(card?.question.options[2].preview).toBeUndefined();
    expect(card?.ask).toEqual(["Which layout should the probe draw?"]);
  });

  it("bounds a preview it is handed, whatever the desktop sent", () => {
    const big = Array.from({ length: 80 }, (_, row) => `row ${row}`).join("\n");
    const entry: TranscriptEntry = { ...ENTRY, questions: [ASKED[0], { ...ASKED[1], options: [{ label: "Grid", preview: big }, { label: "List", preview: "x".repeat(5000) }] }] };
    const card = mergeAskedQuestion(entry, dialogOf(PREVIEW_PAGE));
    const [grid, list] = card!.question.options;
    expect(grid.preview?.split("\n")).toHaveLength(40);
    expect(list.preview?.length).toBeLessThanOrEqual(2000);
  });

  it("walks the pages by the focused tab, the question text when the screen does not say", () => {
    const live = dialogOf(PREVIEW_PAGE)!;
    // The tab row says the second step is on screen.
    expect(mergeAskedQuestion(ENTRY, { ...live, tabFocus: 1 })?.question.options[0].label).toBe("Grid");
    // Nothing painted on the row: the question's own text tells.
    expect(mergeAskedQuestion(ENTRY, { ...live, tabFocus: null })?.question.options[0].label).toBe("Grid");
    expect(mergeAskedQuestion(ENTRY, { ...live, tabFocus: null, ask: ["Another question altogether?"] })).toBeNull();
    // A tab row that points at the colours while these rows are the layout's: the rows do not match.
    expect(mergeAskedQuestion(ENTRY, { ...live, tabFocus: 0 })).toBeNull();
    // The Submit step has no question of the entry's.
    expect(mergeAskedQuestion(ENTRY, { ...live, tabFocus: 2 })).toBeNull();
  });

  it("falls back to the screen when the screen is not this question", () => {
    // Headers differ: another dialog of the same shape.
    const live = dialogOf(MULTI_PAGE)!;
    expect(mergeAskedQuestion(ENTRY, { ...live, tabs: [{ label: "Other", answered: false }, live.tabs[1]] })).toBeNull();
    expect(mergeAskedQuestion(ENTRY, { ...live, tabs: [live.tabs[0]] })).toBeNull();
    // A permission prompt has no tab row at all.
    const permission = dialogOf(["❯ remove it", "", "Do you want to proceed?", "❯ 1. Yes", "  2. No", "", "  Esc to cancel"])!;
    expect(mergeAskedQuestion(ENTRY, permission)).toBeNull();
    // A row the entry names is not on screen.
    const reworded = { ...ENTRY, questions: [{ ...ASKED[0], options: [{ label: "Crimson" }, ...ASKED[0].options!.slice(1)] }, ASKED[1]] };
    expect(mergeAskedQuestion(reworded, live)).toBeNull();
    // The review step has no question of the entry's to put in.
    expect(mergeAskedQuestion(ENTRY, dialogOf(REVIEW_PAGE))).toBeNull();
    // No entry, or one that is not waiting.
    expect(mergeAskedQuestion(null, live)).toBeNull();
    expect(mergeAskedQuestion({ ...ENTRY, blocking: undefined }, live)).toBeNull();
  });

  it("tells a truncated row from the entry's whole one", () => {
    const entry: TranscriptEntry = { ...ENTRY, questions: [{ ...ASKED[0], options: [{ label: "A very long first answer that the pane cuts" }, ...ASKED[0].options!.slice(1)] }, ASKED[1]] };
    const rows = MULTI_PAGE.map((row) => row.replace("[✔] Red", "[✔] A very long first answer that…"));
    expect(mergeAskedQuestion(entry, dialogOf(rows))?.question.options[0].label).toBe("A very long first answer that the pane cuts");
  });
});

describe("a waiting entry before the screen shows the dialog", () => {
  it("is a read-only card of the first question, only where the caller allows it", () => {
    expect(mergeAskedQuestion(ENTRY, null)).toBeNull();
    const card = mergeAskedQuestion(ENTRY, null, true);
    expect(card?.kind).toBe("entry");
    expect(card?.question.readOnly).toBe(true);
    expect(card?.question.source).toBe("entry");
    expect(card?.question.current).toBe(-1);
    expect(card?.question.options.map((option) => [option.label, option.number, option.ticked])).toEqual([["Red", 1, undefined], ["Blue", 2, undefined], ["Green", 3, undefined]]);
    expect(card?.question.multiSelect).toBe(true);
    expect(card?.ask).toEqual(["Which colours should the probe use?"]);
    expect(card?.tabs).toEqual([{ label: "Colours", answered: false }, { label: "Layout", answered: false }]);
    expect(card?.tabFocus).toBe(0);
    expect(card?.context).toEqual([]);
    expect(card?.signature).toBe("entry:2026-11-18T09:19:13.591Z");
  });

  it("is not made for an entry without a question to show", () => {
    expect(mergeAskedQuestion({ ...ENTRY, questions: [{ question: "Anything?" }] }, null, true)).toBeNull();
  });
});

describe("whether the phone's screen lets an entry-only card stand", () => {
  const screenOf = (rows: string[]) => readableScreen(plainBuffer(rows), 300).lines;
  const BOX = [`${"─".repeat(60)} my-project ─`, "❯ ", "─".repeat(76), "  ? for shortcuts"];
  it("shows it while the dialog is not drawn yet: a busy row over the box, or no box at all", () => {
    expect(entryCardAllowed(screenOf(["❯ ask me", "", "✻ Thinking… (3s · ↓ 120 tokens · esc to interrupt)", "", ...BOX]), "Claude")).toBe(true);
    expect(entryCardAllowed(screenOf(["Something the reader cannot name", "", "  nor this"]), "Claude")).toBe(true);
  });
  it("hides it when the session sits idle at its box: the entry is a leftover", () => {
    expect(entryCardAllowed(screenOf(["❯ ask me", "", "⏺ Done.", "", ...BOX]), "Claude")).toBe(false);
  });
  it("hides it on a blank screen and for a CLI that does not write these entries", () => {
    expect(entryCardAllowed([], "Claude")).toBe(false);
    expect(entryCardAllowed(screenOf(["", "  ", ""]), "Claude")).toBe(false);
    expect(entryCardAllowed(screenOf(["something"]), "Codex")).toBe(false);
  });
});
