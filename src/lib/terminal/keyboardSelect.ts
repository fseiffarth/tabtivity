/**
 * Keyboard selection in a terminal pane (Ctrl+Shift+X): a cursor the arrow keys
 * walk over the buffer — scrollback included — and a selection anchored where
 * Shift or `v` was first pressed. xterm has no such mode of its own, and under
 * an agent TUI the keys cannot go to the program anyway (the agent owns them),
 * so the mode takes every key until Enter copies or Esc leaves.
 *
 * Pure: the pane feeds it keys plus the buffer geometry and draws the result
 * with xterm's own selection (`term.select` / `term.selectLines`).
 */
import type { IBufferRange } from "@xterm/xterm";

/** A cell in absolute buffer coordinates (row 0 = oldest scrollback row). */
export interface CellPos {
  x: number;
  y: number;
}

export interface KeySelectState {
  cursor: CellPos;
  /** Where the selection started; null = only the cursor is shown. */
  anchor: CellPos | null;
  /** Whole-line selection (`V`). */
  lines: boolean;
}

/** What the mode reads off the pane. */
export interface KeySelectGeometry {
  cols: number;
  rows: number;
  /** Rows in the buffer, scrollback included. */
  length: number;
  lineText(y: number): string;
}

export interface KeySelectKey {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export type KeySelectStep = { kind: "move"; state: KeySelectState } | { kind: "copy" } | { kind: "exit" } | { kind: "ignore" };

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** The state a fresh mode starts in: an existing mouse selection is kept (so
 *  it can be refined from the keyboard), otherwise the cursor sits on `at`. */
export function startKeySelect(at: CellPos, selection: IBufferRange | undefined, cols: number): KeySelectState {
  if (selection && (selection.start.x !== selection.end.x || selection.start.y !== selection.end.y)) {
    const { start, end } = selection;
    // xterm's end is exclusive; the cursor sits on the last selected cell.
    const cursor = end.x > 0 ? { x: end.x - 1, y: end.y } : { x: cols - 1, y: Math.max(start.y, end.y - 1) };
    return { cursor, anchor: { ...start }, lines: false };
  }
  return { cursor: { ...at }, anchor: null, lines: false };
}

const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch);

/** Column of the next word start right of `x` on `text`, or null past the end. */
function nextWordStart(text: string, x: number): number | null {
  let i = x;
  while (i < text.length && isWordChar(text[i])) i++;
  while (i < text.length && !isWordChar(text[i])) i++;
  return i < text.length ? i : null;
}

/** Column of the word start left of `x` on `text`, or null before the start. */
function prevWordStart(text: string, x: number): number | null {
  let i = Math.min(x, text.length) - 1;
  while (i >= 0 && !isWordChar(text[i])) i--;
  if (i < 0) return null;
  while (i > 0 && isWordChar(text[i - 1])) i--;
  return i;
}

/** Last used column of row `y` (0 for a blank row). */
function lineEnd(geo: KeySelectGeometry, y: number): number {
  return clamp(geo.lineText(y).trimEnd().length - 1, 0, geo.cols - 1);
}

function moved(state: KeySelectState, geo: KeySelectGeometry, key: KeySelectKey): CellPos | null {
  const { x, y } = state.cursor;
  const last = geo.length - 1;
  const word = key.ctrlKey || key.altKey;
  switch (key.key) {
    case "ArrowLeft":
    case "h":
    case "H":
      if (word) {
        for (let row = y, from = x; row >= 0; row--, from = geo.cols) {
          const col = prevWordStart(geo.lineText(row), from);
          if (col !== null) return { x: col, y: row };
        }
        return { x: 0, y: 0 };
      }
      return x > 0 ? { x: x - 1, y } : y > 0 ? { x: geo.cols - 1, y: y - 1 } : { x, y };
    case "ArrowRight":
    case "l":
    case "L":
      if (word) {
        for (let row = y, from = x; row <= last; row++, from = -1) {
          const text = geo.lineText(row);
          const col = from < 0 ? (isWordChar(text[0]) ? 0 : nextWordStart(text, 0)) : nextWordStart(text, from);
          if (col !== null) return { x: col, y: row };
        }
        return { x: lineEnd(geo, last), y: last };
      }
      return x < geo.cols - 1 ? { x: x + 1, y } : y < last ? { x: 0, y: y + 1 } : { x, y };
    case "ArrowUp":
    case "k":
    case "K":
      return { x, y: y - 1 };
    case "ArrowDown":
    case "j":
    case "J":
      return { x, y: y + 1 };
    case "PageUp":
      return { x, y: y - geo.rows };
    case "PageDown":
      return { x, y: y + geo.rows };
    case "Home":
    case "0":
      return key.ctrlKey ? { x: 0, y: 0 } : { x: 0, y };
    case "End":
    case "$":
      return key.ctrlKey ? { x: lineEnd(geo, last), y: last } : { x: lineEnd(geo, y), y };
    case "g":
      return { x: 0, y: 0 };
    case "G":
      return { x: lineEnd(geo, last), y: last };
    default:
      return null;
  }
}

/** Apply one keydown. Movement with Shift held extends (or starts) the
 *  selection; `v` / `V` toggle a character / line selection at the cursor. */
export function keySelectStep(state: KeySelectState, key: KeySelectKey, geo: KeySelectGeometry, mac = false): KeySelectStep {
  // On a Mac ⌘ is the primary modifier (2442x): ⌘C copies and ⌘X leaves, as
  // Ctrl does elsewhere; any other ⌘ chord is not this mode's.
  if (key.metaKey && !(mac && /^[cCxX]$/.test(key.key))) return { kind: "ignore" };
  const primary = key.ctrlKey || (mac && key.metaKey);
  switch (key.key) {
    case "Escape":
    case "q":
      return { kind: "exit" };
    case "Enter":
    case "y":
      return { kind: "copy" };
    case "c":
    case "C":
      // Ctrl+C (and Ctrl+Shift+C) copies here: nothing typed in this mode
      // reaches the program, so it cannot mean "interrupt".
      return primary ? { kind: "copy" } : { kind: "ignore" };
    case "x":
    case "X":
      // The chord that entered the mode leaves it again.
      return primary ? { kind: "exit" } : { kind: "ignore" };
    case "v":
      return { kind: "move", state: { ...state, anchor: state.anchor && !state.lines ? null : { ...state.cursor }, lines: false } };
    case "V":
      return { kind: "move", state: { ...state, anchor: state.anchor && state.lines ? null : (state.anchor ?? { ...state.cursor }), lines: !state.lines } };
  }
  const to = moved(state, geo, key);
  if (!to) return { kind: "ignore" };
  const cursor = { x: clamp(to.x, 0, geo.cols - 1), y: clamp(to.y, 0, Math.max(0, geo.length - 1)) };
  // `G` and `$` are typed with Shift; there it picks the key, not "extend".
  const extend = key.shiftKey && key.key !== "G" && key.key !== "$";
  const anchor = extend && !state.anchor ? { ...state.cursor } : state.anchor;
  return { kind: "move", state: { ...state, cursor, anchor } };
}

/** The selected span as xterm's end-exclusive buffer range. With no anchor it
 *  is the cursor's whole row — what Enter copies when nothing is selected. */
export function keySelectRange(state: KeySelectState, cols: number): IBufferRange {
  const { cursor, anchor } = state;
  if (!anchor) return { start: { x: 0, y: cursor.y }, end: { x: cols, y: cursor.y } };
  const [a, b] = anchor.y < cursor.y || (anchor.y === cursor.y && anchor.x <= cursor.x) ? [anchor, cursor] : [cursor, anchor];
  if (state.lines) return { start: { x: 0, y: a.y }, end: { x: cols, y: b.y } };
  return { start: { ...a }, end: { x: b.x + 1, y: b.y } };
}

/** What to draw: the arguments of `term.select(column, row, length)` — the
 *  cursor alone is shown as a one-cell selection. */
export function keySelectHighlight(state: KeySelectState, cols: number): { column: number; row: number; length: number } {
  if (!state.anchor) return { column: state.cursor.x, row: state.cursor.y, length: 1 };
  const { start, end } = keySelectRange(state, cols);
  return { column: start.x, row: start.y, length: (end.y - start.y) * cols + (end.x - start.x) };
}

/** The first viewport row that shows `y`, or null when it is already on screen. */
export function scrollToShow(y: number, viewportY: number, rows: number): number | null {
  if (y < viewportY) return y;
  if (y >= viewportY + rows) return y - rows + 1;
  return null;
}
