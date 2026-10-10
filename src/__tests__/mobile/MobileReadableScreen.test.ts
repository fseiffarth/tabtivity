import { describe, expect, it } from "vitest";
import { inputFrameStart } from "../../../mobile-web/src/terminal/statusLine";
import {
  MAX_LINES,
  dedentLines,
  joinProseWraps,
  readableRange,
  readableScreen,
  readableText,
  type ReadableBufferLike,
  type ReadableCellLike,
} from "../../../mobile-web/src/terminal/readableScreen";
import {
  HISTORY_CHUNK,
  HISTORY_MAX_LINES,
  absorbHistory,
  emptyHistory,
  lastHistoryText,
  shiftHistory,
} from "../../../mobile-web/src/terminal/readableHistory";
import { BRAND } from "../../lib/brand";

/** Marks a row xterm wrapped from the row above it. An explicit glyph, not a
 * leading space: a wrap point regularly *is* a space, and the two must not be
 * the same character in a fixture about exactly that. */
const WRAP = "↵";

/** A buffer of plain rows: no cell attributes, the shape a terminal without
 * styling produces. */
function plainBuffer(rows: string[]): ReadableBufferLike {
  return {
    length: rows.length,
    getLine(row) {
      const source = rows[row];
      if (source === undefined) return undefined;
      const wrapped = source.startsWith(WRAP);
      const text = wrapped ? source.slice(1) : source;
      return { isWrapped: wrapped, translateToString: () => text };
    },
  };
}

interface FakeStyle {
  text: string;
  fg?: number;
  rgb?: number;
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
}

/** A single styled row, cell by cell, mirroring xterm's `IBufferCell`. */
function styledBuffer(runs: FakeStyle[]): ReadableBufferLike {
  const cells: ReadableCellLike[] = [];
  for (const run of runs) {
    for (const char of run.text) {
      cells.push({
        getChars: () => char,
        getWidth: () => 1,
        isBold: () => (run.bold ? 1 : 0),
        isItalic: () => 0,
        isDim: () => (run.dim ? 1 : 0),
        isUnderline: () => 0,
        isStrikethrough: () => 0,
        isInverse: () => (run.inverse ? 1 : 0),
        isInvisible: () => 0,
        isFgDefault: () => run.fg === undefined && run.rgb === undefined,
        isBgDefault: () => true,
        isFgPalette: () => run.fg !== undefined,
        isBgPalette: () => false,
        isFgRGB: () => run.rgb !== undefined,
        isBgRGB: () => false,
        getFgColor: () => run.fg ?? run.rgb ?? 0,
        getBgColor: () => 0,
      });
    }
  }
  const text = runs.map((run) => run.text).join("");
  return {
    length: 1,
    getLine: () => ({
      length: cells.length,
      translateToString: () => text,
      getCell: (x) => cells[x],
    }),
  };
}

const texts = (buffer: ReadableBufferLike) => readableScreen(buffer).lines.map((line) => line.text);

describe(`${BRAND.display} Mobile readable terminal view`, () => {
  it("rejoins wrapped rows so the phone re-wraps at its own width", () => {
    // The desktop tmux window is far wider than a phone. Keeping xterm's
    // physical breaks would show that window's column count as hard newlines.
    expect(texts(plainBuffer([
      "The agent explained the change in one long",
      `${WRAP} sentence that tmux had to wrap.`,
      "Next line.",
    ]))).toEqual([
      "The agent explained the change in one long sentence that tmux had to wrap.",
      "Next line.",
    ]);
  });

  it("keeps the space a row was wrapped on, and drops the row's padding", () => {
    // Trimming each row before joining glued the last word of one row to the
    // first of the next: "come from" + "the session" read as "come fromthe".
    expect(texts(plainBuffer(["come from ", `${WRAP}the session itself.`, "done      "])))
      .toEqual(["come from the session itself.", "done"]);
  });

  it("carries the colour and emphasis the program actually emitted", () => {
    // Style is read off the cells, never guessed from the words — the old
    // parser painted prose like \"Error handling in Rust\" as a red verdict.
    const [line] = readableScreen(styledBuffer([
      { text: "ok ", fg: 2, bold: true },
      { text: "plain ", },
      { text: "rgb", rgb: 0x8c7df4 },
    ])).lines;
    expect(line.spans.map((span) => [span.text, span.className, span.color])).toEqual([
      ["ok ", "b", "#55d187"],
      ["plain ", undefined, undefined],
      ["rgb", undefined, "rgb(140,125,244)"],
    ]);
  });

  it("resolves inverse video against the terminal's own colours", () => {
    const [line] = readableScreen(styledBuffer([{ text: "sel", inverse: true }])).lines;
    expect(line.spans[0].color).toBe("#0b0d13");
    expect(line.spans[0].background).toBe("#e7e9f2");
  });

  it("drops frame decoration but never the text inside it", () => {
    expect(texts(plainBuffer([
      "╭──────────────────────────────╮",
      "│ > run the tests              │",
      "╰──────────────────────────────╯",
    ]))).toEqual(["> run the tests"]);
  });

  it("marks the line a dropped rule stood above, without opening a break", () => {
    // Claude Code 2.1.286 fences a permission prompt's command in dashed
    // rules; the rule goes, but the dialog's heading still has to stop there.
    const screen = readableScreen(plainBuffer([
      " Write Unix timestamp to a.txt",
      "╌".repeat(40),
      " date +%s > a.txt",
      "╌".repeat(40),
      " Do you want to proceed?",
    ]));
    expect(screen.lines.map((line) => line.text)).toEqual([
      " Write Unix timestamp to a.txt",
      " date +%s > a.txt",
      " Do you want to proceed?",
    ]);
    expect(screen.lines.map((line) => line.afterRule ?? false)).toEqual([false, true, true]);
  });

  it("leaves a frame edge that is not the row's own, indent and all", () => {
    // OpenCode's full TUI paints a centred dialog over its composer box, so
    // each of the dialog's rows carries the box's `┃` far in from the margin.
    // Read as this row's left edge it took the whole indent with it, which
    // pulled those rows out of column with the rest of the dialog — and every
    // reader of the overlay works by column.
    expect(texts(plainBuffer([
      "                    Muse Spark 1.2 Free",
      "          ┃         Nemotron 3 Ultra Free",
    ]))).toEqual([
      "                    Muse Spark 1.2 Free",
      "          ┃         Nemotron 3 Ultra Free",
    ]);
  });

  it("removes Codex's labelled divider strokes even across wrapped rows", () => {
    const screen = readableScreen(plainBuffer([
      "• The change is ready.",
      `─ Worked for 2m 10s ${"─".repeat(60)}`,
      `${WRAP}${"─".repeat(80)}`,
      `${WRAP}${"─".repeat(80)}`,
      "› Next task",
    ]));
    expect(readableText(screen.lines)).toBe("• The change is ready.\nWorked for 2m 10s\n› Next task");
    expect(screen.lines[1].spans.map((span) => span.text).join("")).toBe("Worked for 2m 10s");
  });

  it("keeps a divider label's style without its bright border spans", () => {
    const [line] = readableScreen(styledBuffer([
      { text: "─ ", fg: 15 },
      { text: "Worked for 2m", dim: true },
      { text: ` ${"─".repeat(200)}`, fg: 15 },
    ])).lines;
    expect(line.text).toBe("Worked for 2m");
    expect(line.spans).toEqual([{ text: "Worked for 2m", className: "d", color: undefined, background: undefined }]);
  });

  it("still excludes a labelled input frame after its strokes are removed", () => {
    const lines = readableScreen(plainBuffer([
      "Answer text",
      `──────── Project${BRAND.display} ─`,
      "› ",
      "85% context left",
    ])).lines;
    expect(lines[1].text).toBe(`Project${BRAND.display}`);
    expect(lines.slice(0, inputFrameStart(lines)).map((line) => line.text)).toEqual(["Answer text"]);
  });

  it("preserves prose dashes, command flags and inline box drawings", () => {
    const rows = ["— keep this aside —", "git diff --check", "  ├── src", "text ─── text", "─ label without a closing rule"];
    expect(texts(plainBuffer(rows))).toEqual(rows);
  });

  it("keeps a numbered list as text instead of an answerable prompt", () => {
    // The old parser turned any run of numbered lines into an approval dialog
    // whose buttons typed those digits into the agent.
    expect(texts(plainBuffer([
      "Here is what I propose:",
      "  1. Keep xterm as the authority.",
      "  2. Render the buffer with its real colours.",
    ]))).toEqual([
      "Here is what I propose:",
      "  1. Keep xterm as the authority.",
      "  2. Render the buffer with its real colours.",
    ]);
  });

  it("collapses blank runs into one break and trims the edges", () => {
    expect(texts(plainBuffer(["", "", "first", "", "", "", "second", "", ""])))
      .toEqual(["first", "", "second"]);
  });

  it("says so whenever earlier output is left out", () => {
    const rows = Array.from({ length: MAX_LINES + 40 }, (_, index) => `line ${index}`);
    const screen = readableScreen(plainBuffer(rows));
    expect(screen.clipped).toBe(true);
    expect(screen.lines).toHaveLength(MAX_LINES);
    expect(screen.lines[screen.lines.length - 1].text).toBe(`line ${rows.length - 1}`);
  });

  it("keeps line keys stable while the session grows", () => {
    const rows = ["first", "second"];
    const before = readableScreen(plainBuffer(rows)).lines.map((line) => line.key);
    const after = readableScreen(plainBuffer([...rows, "third"])).lines.map((line) => line.key);
    // Keying on the buffer row means a new line does not remount every line
    // above it — which used to destroy a selection mid-gesture.
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it("clips a single runaway line rather than the whole view", () => {
    const [line] = readableScreen(plainBuffer(["x".repeat(40_000)])).lines;
    expect(line.text.endsWith("… [line truncated]")).toBe(true);
    expect(line.text.length).toBeLessThan(5_000);
  });

  it("copies out exactly what is on screen", () => {
    const screen = readableScreen(plainBuffer(["alpha", "", "beta"]));
    expect(readableText(screen.lines)).toBe("alpha\n\nbeta");
  });
});

describe(`${BRAND.display} Mobile lazy terminal history`, () => {
  /** The combined reading — absorbed history plus the live tail, exactly as the
   * Focus view composes them. */
  const view = (buffer: ReadableBufferLike, history: ReturnType<typeof emptyHistory>) => {
    const tail = readableRange(buffer, history.end, buffer.length, lastHistoryText(history));
    while (tail.length > 0 && tail[tail.length - 1].text === "") tail.pop();
    return readableText([
      ...history.chunks.flatMap((chunk) => chunk.lines),
      ...history.open,
      ...tail,
    ]);
  };

  it("absorbs everything above the tail window, once, and reads seamlessly", () => {
    const rows = Array.from({ length: 30 }, (_, index) => `line ${index}`);
    const history = emptyHistory();
    expect(absorbHistory(plainBuffer(rows), history, 5)).toBe(true);
    expect(history.end).toBe(25);
    // A second pass with no new output absorbs nothing more.
    expect(absorbHistory(plainBuffer(rows), history, 5)).toBe(false);
    expect(view(plainBuffer(rows), history)).toBe(rows.join("\n"));
  });

  it("never splits a wrapped logical line at the absorb boundary", () => {
    const rows = ["first", "a long line that", `${WRAP} tmux wrapped`, "prompt"];
    const history = emptyHistory();
    // The boundary lands on the continuation row; it backs off so the tail
    // rebuild re-joins the line whole.
    absorbHistory(plainBuffer(rows), history, 2);
    expect(history.end).toBe(1);
    expect(view(plainBuffer(rows), history)).toBe(
      "first\na long line that tmux wrapped\nprompt",
    );
  });

  it("keeps one paragraph break across the absorb seam and never doubles it", () => {
    const rows = ["above", "", "below", "prompt"];
    const history = emptyHistory();
    absorbHistory(plainBuffer(rows), history, 3);
    expect(history.end).toBe(1);
    expect(view(plainBuffer(rows), history)).toBe("above\n\nbelow\nprompt");
  });

  it("follows a scrollback trim without losing or doubling lines", () => {
    const rows = Array.from({ length: 40 }, (_, index) => `line ${index}`);
    const history = emptyHistory();
    absorbHistory(plainBuffer(rows), history, 10);
    // The buffer trims its oldest 12 rows and 12 new ones arrive.
    const grown = [...rows, ...Array.from({ length: 12 }, (_, index) => `line ${40 + index}`)];
    const trimmed = grown.slice(12);
    shiftHistory(history, 12);
    absorbHistory(plainBuffer(trimmed), history, 10);
    expect(history.lost).toBe(false);
    expect(view(plainBuffer(trimmed), history)).toBe(grown.join("\n"));
  });

  it("says so when rows were trimmed before they could be absorbed", () => {
    const history = emptyHistory();
    shiftHistory(history, 3);
    expect(history.end).toBe(0);
    expect(history.lost).toBe(true);
  });

  it("freezes full chunks with stable ids and bounds the memory", () => {
    const rows = Array.from({ length: HISTORY_MAX_LINES + 2 * HISTORY_CHUNK }, (_, index) => `line ${index}`);
    const history = emptyHistory();
    absorbHistory(plainBuffer(rows), history, 10);
    expect(history.chunks.every((chunk) => chunk.lines.length === HISTORY_CHUNK)).toBe(true);
    expect(history.open.length).toBeLessThan(HISTORY_CHUNK);
    // The oldest chunks were dropped to stay under the cap — and counted.
    const kept = history.chunks.reduce((sum, chunk) => sum + chunk.lines.length, 0);
    expect(kept).toBeLessThanOrEqual(HISTORY_MAX_LINES);
    expect(history.droppedLines).toBeGreaterThan(0);
    expect(history.droppedLines % HISTORY_CHUNK).toBe(0);
    // Keys are unique across chunks and the open tail (React keys).
    const keys = [...history.chunks.flatMap((chunk) => chunk.lines), ...history.open].map((line) => line.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe(`${BRAND.display} Mobile side panel`, () => {
  /** A row split at column 40: the conversation left, a panel right. */
  const split = (left: string, right = "") => `${left.padEnd(40)}${right}`;
  const rule = "─".repeat(30);

  it("cuts a panel drawn beside the conversation off every row it shares", () => {
    // Claude Code's diff view: the AGENTS.md diff sat in the row of the prompt.
    const rows = [
      split("● Done.", "3 files changed          ✕"),
      split("", "AGENTS.md                +7"),
      split("", rule),
      split("❯ why is this shown", "238  git config core.hooksPath"),
      split("", "239  .githooks"),
      split("", rule),
      split("● Because the panel shares rows."),
      "─".repeat(70),
      "❯ ",
    ];
    const lines = readableScreen(plainBuffer(rows)).lines.map((row) => row.text);
    expect(lines).toEqual(["● Done.", "", "❯ why is this shown", "", "● Because the panel shares rows.", "❯"]);
  });

  it("cuts the fullscreen diff panel at the divider it draws down every row", () => {
    // Claude Code 2.1.292: no gutter, a `│` on every row, footer included; a
    // wide glyph left of it puts the divider one character earlier.
    const pane = (left: string, right = "") => `${left.padEnd(30)}│${right}`;
    const rows = [
      pane("● Wrote the plan.", "1 file changed"),
      pane("", "docs/plan.md (untracked)"),
      pane("│ How should homes sync, so", "─".repeat(20)),
      pane("│ nothing leaks?", "New file not yet staged."),
      `${"完成 Shipped".padEnd(28)}│Run \`git add\` to see line counts.`,
      `${"─".repeat(30)}│`,
      pane("❯ "),
      `${"─".repeat(30)}│`,
      pane("  ⏵⏵ auto mode on", "+1 file edited before this session"),
    ];
    const lines = readableScreen(plainBuffer(rows)).lines.map((row) => row.text);
    expect(lines).toEqual(["● Wrote the plan.", "", "How should homes sync, so", "nothing leaks?", "完成 Shipped", "❯", "  ⏵⏵ auto mode on"]);
  });

  it("leaves a table's columns whole: they never run through every row", () => {
    const rows = [
      "┌──────────────────────────┬──────────┐",
      ...Array.from({ length: 8 }, (_, index) => `│ row ${index}                    │ value    │`),
      "└──────────────────────────┴──────────┘",
      "❯ ",
    ];
    const lines = readableScreen(plainBuffer(rows)).lines.map((row) => row.text);
    expect(lines[0]).toBe("row 0                    │ value");
  });

  it("leaves rows whole without two rules at one column", () => {
    const rows = [
      split("● One rule is not a panel.", rule),
      split("A long answer line runs", "straight past the column."),
    ];
    const lines = readableScreen(plainBuffer(rows)).lines.map((row) => row.text);
    expect(lines).toEqual([split("● One rule is not a panel.", rule), split("A long answer line runs", "straight past the column.")]);
  });
});

describe(`${BRAND.display} Mobile Codex sparkle`, () => {
  it("reads Codex's scattered one-dot braille as blank, so its input box stays found", () => {
    const rows = [
      "• Working (35s • esc to interrupt)",
      "",
      "                    ⢀     ⠁          ⠐     ⠐⠂ ⠄",
      "›⠁Ask Codex to do anything   ⠈             ⢀",
      "      ⠠⢀⠐                 ⠄         ⠠",
      `  gpt-6-astra high · ~/${BRAND.slug}/projects/project${BRAND.slug}`,
    ];
    const lines = readableScreen(plainBuffer(rows)).lines;
    expect(lines.map((row) => row.text)).toEqual([
      "• Working (35s • esc to interrupt)",
      "",
      "› Ask Codex to do anything",
      "",
      `  gpt-6-astra high · ~/${BRAND.slug}/projects/project${BRAND.slug}`,
    ]);
    // The frame (with Codex's padding row above the box) is cut; the work stays.
    expect(lines.slice(0, inputFrameStart(lines, "Codex")).map((row) => row.text)).toEqual(["• Working (35s • esc to interrupt)"]);
  });

  it("keeps denser braille: spinners and plots are not sparkle", () => {
    const lines = readableScreen(plainBuffer(["⠋ Thinking", "⣿⣶⣤⣀ load"])).lines.map((row) => row.text);
    expect(lines).toEqual(["⠋ Thinking", "⣿⣶⣤⣀ load"]);
  });

  it("drops the indent a block shares, for text shown as the phone's own", () => {
    // A dialog draws its question in from the frame; the phone's question
    // heading lays it out itself (`QuestionList`). The deepest line keeps
    // what it has beyond the shared indent, and a blank stays blank.
    const lines = readableScreen(plainBuffer([
      "  You’re now using Luna.",
      "",
      "    Add credits or upgrade.",
    ])).lines;
    expect(dedentLines(lines).map((line) => line.text)).toEqual([
      "You’re now using Luna.",
      "",
      "  Add credits or upgrade.",
    ]);
    // Flush already, and the lines come back untouched.
    const flush = readableScreen(plainBuffer(["Do you want to proceed?"])).lines;
    expect(dedentLines(flush).map((line) => line.text)).toEqual(["Do you want to proceed?"]);
  });

  it("dedents the spans too, not just the text", () => {
    const styled = readableScreen(styledBuffer([{ text: "  " }, { text: "Question", bold: true }])).lines;
    const [line] = dedentLines(styled);
    expect(line.text).toBe("Question");
    expect(line.spans.map((span) => span.text).join("")).toBe("Question");
  });
});

describe(`${BRAND.display} Mobile prose rewrap`, () => {
  const rows = (...texts: string[]) => texts.map((text, index) => ({ key: String(index), text, spans: [{ text }] }));

  it("rejoins the rows a TUI wrapped itself, and keeps the breaks it meant", () => {
    // Claude Code prints each wrapped row as a line of its own, so xterm never
    // marks the continuation: the phone showed the pane's width as hard breaks.
    const joined = joinProseWraps(rows(
      "Four other-session commits sit unpushed on develop. How should I land my",
      "Windows/CodeQL fix?",
      "",
      "Short line.",
      "Another sentence the session started on a row of its own.",
      "- a list item",
    ));
    expect(joined.map((line) => line.text)).toEqual([
      "Four other-session commits sit unpushed on develop. How should I land my Windows/CodeQL fix?",
      "",
      "Short line.",
      "Another sentence the session started on a row of its own.",
      "- a list item",
    ]);
    expect(joined[0].spans.map((span) => span.text).join("")).toBe(joined[0].text);
  });

  it("drops the hanging indent of a wrapped agent message", () => {
    const joined = joinProseWraps(rows(
      "● My fix is ready and verified, but pushing develop now would also push four",
      "  other commits.",
    ));
    expect(joined.map((line) => line.text)).toEqual([
      "● My fix is ready and verified, but pushing develop now would also push four other commits.",
    ]);
  });
});
