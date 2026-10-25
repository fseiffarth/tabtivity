/**
 * Pure selection model for the table viewer: which cells, rows or columns the
 * reader has picked, resolved against what is on screen. No DOM, no React —
 * unit-tested in isolation (`src/__tests__/viewers/tableSelection.test.ts`).
 *
 * A selection is stored by *source* row index (the `RowRef.index` a sort or
 * filter carries) and *parsed* column index, never by screen position, so it
 * keeps pointing at the same cells when the reader re-sorts, filters or hides a
 * column. It is only turned into positions in the current order when a range is
 * needed (`resolveRange`), and a selection whose anchor or focus is currently
 * off screen simply resolves to nothing rather than being dropped.
 */
import type { RowRef } from "./table";

export interface CellRef {
  /** Source row index (`RowRef.index`) — `0` is the header, so never a body cell. */
  row: number;
  /** Parsed column index. */
  col: number;
}

export type GridSelection =
  | { kind: "cells"; anchor: CellRef; focus: CellRef }
  | { kind: "rows"; anchor: number; focus: number }
  | { kind: "cols"; anchor: number; focus: number };

/** A selection in screen terms: inclusive positions into the visible rows and
 *  into the visible columns (`cols`). */
export interface SelRange {
  rowLo: number;
  rowHi: number;
  colLo: number;
  colHi: number;
}

const span = (a: number, b: number): [number, number] => (a <= b ? [a, b] : [b, a]);

/** The selection's rectangle on screen, or `null` when it is empty or one of its
 *  ends is filtered out / hidden right now. */
export function resolveRange(
  sel: GridSelection | null,
  visible: readonly RowRef[],
  cols: readonly number[],
): SelRange | null {
  if (!sel || visible.length === 0 || cols.length === 0) return null;
  const rowPos = (index: number) => visible.findIndex((r) => r.index === index);
  if (sel.kind === "cells") {
    const ar = rowPos(sel.anchor.row);
    const fr = rowPos(sel.focus.row);
    const ac = cols.indexOf(sel.anchor.col);
    const fc = cols.indexOf(sel.focus.col);
    if (ar < 0 || fr < 0 || ac < 0 || fc < 0) return null;
    const [rowLo, rowHi] = span(ar, fr);
    const [colLo, colHi] = span(ac, fc);
    return { rowLo, rowHi, colLo, colHi };
  }
  if (sel.kind === "rows") {
    const a = rowPos(sel.anchor);
    const f = rowPos(sel.focus);
    if (a < 0 || f < 0) return null;
    const [rowLo, rowHi] = span(a, f);
    return { rowLo, rowHi, colLo: 0, colHi: cols.length - 1 };
  }
  const a = cols.indexOf(sel.anchor);
  const f = cols.indexOf(sel.focus);
  if (a < 0 || f < 0) return null;
  const [colLo, colHi] = span(a, f);
  return { rowLo: 0, rowHi: visible.length - 1, colLo, colHi };
}

/** The values a copy puts on the clipboard, row by row. A column selection also
 *  carries the header's names, as the first line, so a pasted column is labelled. */
export function selectionValues(
  sel: GridSelection,
  range: SelRange,
  visible: readonly RowRef[],
  cols: readonly number[],
  header: readonly string[],
): string[][] {
  const picked = cols.slice(range.colLo, range.colHi + 1);
  const out: string[][] = [];
  if (sel.kind === "cols") out.push(picked.map((c) => header[c] ?? ""));
  for (let r = range.rowLo; r <= range.rowHi; r++) {
    out.push(picked.map((c) => visible[r].cells[c] ?? ""));
  }
  return out;
}

/** Tab-separated text, the form spreadsheets paste: a field holding a tab, a line
 *  break or a double quote is wrapped in quotes (quotes doubled). */
export function valuesToTsv(grid: readonly (readonly string[])[]): string {
  return grid
    .map((row) =>
      row.map((v) => (/[\t\r\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join("\t"),
    )
    .join("\n");
}

/** How many rows and columns a range covers. */
export function rangeSize(range: SelRange): { rows: number; cols: number } {
  return { rows: range.rowHi - range.rowLo + 1, cols: range.colHi - range.colLo + 1 };
}

/** Select everything on screen: every visible row, whatever the columns. */
export function selectAllRows(visible: readonly RowRef[]): GridSelection | null {
  if (visible.length === 0) return null;
  return { kind: "rows", anchor: visible[0].index, focus: visible[visible.length - 1].index };
}

/**
 * Move the selection's focus one step with an arrow key. Without `extend` the
 * anchor follows, collapsing to a single cell (or a single row / column when
 * that is what was selected); with it the anchor stays, growing the range.
 * Nothing selected yet starts at the first visible cell. Returns `null` when
 * there is nothing to move over.
 */
export function moveFocus(
  sel: GridSelection | null,
  dRow: number,
  dCol: number,
  extend: boolean,
  visible: readonly RowRef[],
  cols: readonly number[],
): GridSelection | null {
  if (visible.length === 0 || cols.length === 0) return null;
  const first: GridSelection = {
    kind: "cells",
    anchor: { row: visible[0].index, col: cols[0] },
    focus: { row: visible[0].index, col: cols[0] },
  };
  if (!sel) return first;
  const clamp = (n: number, len: number) => Math.min(Math.max(n, 0), len - 1);
  if (sel.kind === "cells") {
    const at = visible.findIndex((x) => x.index === sel.focus.row);
    const atCol = cols.indexOf(sel.focus.col);
    if (at < 0 || atCol < 0) return first;
    const focus = {
      row: visible[clamp(at + dRow, visible.length)].index,
      col: cols[clamp(atCol + dCol, cols.length)],
    };
    return { kind: "cells", anchor: extend ? sel.anchor : focus, focus };
  }
  if (sel.kind === "rows") {
    const at = visible.findIndex((x) => x.index === sel.focus);
    if (at < 0) return first;
    const focus = visible[clamp(at + dRow, visible.length)].index;
    return { kind: "rows", anchor: extend ? sel.anchor : focus, focus };
  }
  const at = cols.indexOf(sel.focus);
  if (at < 0) return first;
  const focus = cols[clamp(at + dCol, cols.length)];
  return { kind: "cols", anchor: extend ? sel.anchor : focus, focus };
}
