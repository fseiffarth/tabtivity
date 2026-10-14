/**
 * The phone's lazy history follows xterm's scrollback trims through an
 * INTERNAL emitter (`_core._bufferService.buffers.normal.lines.onTrim`, read by
 * `scrollbackTrimEvent`) — xterm has no public event for it. The pipeline test
 * fakes that path; this one runs the real `@xterm/xterm`, so a release that
 * renames or reshapes it fails here instead of the Focus view silently falling
 * back to whole-screen rebuilds (or, worse, absorbing the wrong rows).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { emptyHistory, scrollbackTrimEvent, shiftHistory } from "../../../mobile-web/src/terminal/readableHistory";
import { bufferRows } from "../../../mobile-web/src/terminal/subagentInput";
import { installXtermLayout, written } from "../helpers/realXterm";

const SCROLLBACK = 5;
const ROWS = 3;
const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `line ${from + i}\r\n`).join("");

let restoreLayout: () => void;
beforeAll(() => {
  restoreLayout = installXtermLayout();
});
afterAll(() => restoreLayout());

function openTerm() {
  const term = new Terminal({ cols: 20, rows: ROWS, scrollback: SCROLLBACK, disableStdin: true });
  term.open(document.body.appendChild(document.createElement("div")));
  return term;
}

describe("the scrollback trim emitter on the real xterm", () => {
  it("is where the phone looks for it", () => {
    expect(typeof scrollbackTrimEvent(openTerm())).toBe("function");
  });

  it("reports each trim in rows, so the history keeps pointing at the same line", async () => {
    const term = openTerm();
    const trims: number[] = [];
    const history = emptyHistory();
    scrollbackTrimEvent(term)!((amount) => {
      trims.push(amount);
      shiftHistory(history, amount);
    });
    // Fill the buffer to its cap (scrollback + screen) without a trim.
    await written(term, lines(0, SCROLLBACK + ROWS - 1));
    expect(trims).toEqual([]);
    const buf = term.buffer.normal;
    history.end = 4;
    expect(buf.getLine(history.end)?.translateToString(true)).toBe("line 4");
    // Three more rows push three off the top; `end` moves with them.
    await written(term, lines(SCROLLBACK + ROWS - 1, SCROLLBACK + ROWS + 2));
    expect(trims.reduce((a, b) => a + b, 0)).toBe(3);
    expect(history.end).toBe(1);
    expect(buf.getLine(history.end)?.translateToString(true)).toBe("line 4");
    expect(history.lost).toBe(false);
    // The phone's screen reader sees the same tail.
    expect(bufferRows(buf, 2)).toEqual([`line ${SCROLLBACK + ROWS + 1}`, ""]);
  });

  it("goes quiet on a reset, which is why the phone re-reads it after every one", async () => {
    const term = openTerm();
    const before: number[] = [];
    const oldEvent = scrollbackTrimEvent(term)!;
    oldEvent((amount) => before.push(amount));
    term.reset();
    const after: number[] = [];
    const newEvent = scrollbackTrimEvent(term)!;
    expect(newEvent).not.toBe(oldEvent);
    newEvent((amount) => after.push(amount));
    await written(term, lines(0, SCROLLBACK + ROWS + 4));
    expect(before).toEqual([]);
    expect(after.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it("is undefined, not a throw, on a terminal without it", () => {
    expect(scrollbackTrimEvent({})).toBeUndefined();
    expect(scrollbackTrimEvent({ _core: { _bufferService: { buffers: {} } } })).toBeUndefined();
  });
});
