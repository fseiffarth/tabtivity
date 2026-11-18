// Imposition for the print preview: several logical pages on one physical sheet
// (N-up), or the page order and 2-up sheets of a saddle-stitch booklet.
//
// Pure arithmetic, no DOM and no PDF: `planImposition` says which page of the
// print sequence lands in which cell of which sheet, and `cellRects` where the
// cells are on a sheet. Both consumers — the preview (`printDocument` builds the
// same grid out of CSS) and the vector PDF (`layoutPrintPdf` places form XObjects)
// — read the same plan, so what the preview shows is what the printer gets. The
// page selection and the strip's order are settled BEFORE this: it only ever sees
// a count of sequence positions.

/** Pages per sheet the N-up control offers. */
export const NUP_CHOICES = [1, 2, 4, 6, 9, 16] as const;
export type NUp = (typeof NUP_CHOICES)[number];

/** Two-sided printing, a printer setting rather than a layout: `long` flips on the
 *  sheet's long edge, `short` on its short edge (CUPS' `two-sided-long-edge` /
 *  `-short-edge`). */
export type Duplex = "none" | "long" | "short";
export const DUPLEX_CHOICES = ["none", "long", "short"] as const;

/** The gap between neighbouring cells, in cm. */
export const GUTTER_CM = 0.3;

/** The part of the print options imposition reads. */
export interface ImposeMode {
  nup: number;
  booklet: boolean;
}

/** Logical pages on each sheet: a booklet is always two to a side. */
export function pagesPerSheet(mode: ImposeMode): number {
  return mode.booklet ? 2 : NUP_CHOICES.includes(mode.nup as NUp) ? mode.nup : 1;
}

/** Whether the print is anything but one page per sheet. */
export function isImposed(mode: ImposeMode): boolean {
  return pagesPerSheet(mode) > 1;
}

/**
 * Columns × rows of the grid for `perSheet` pages. Reading order is left to right,
 * then top to bottom. Two and six to a sheet are the shapes that depend on the
 * sheet: on an upright sheet they stack (1×2, 2×3), so each cell is wider than
 * tall — a landscape cell — and an upright page is turned to fill it (see
 * `autoTurn`); on a landscape sheet they sit side by side (2×1, 3×2).
 */
export function gridFor(perSheet: number, landscape: boolean): { cols: number; rows: number } {
  let upright: [number, number];
  switch (perSheet) {
    case 2:
      upright = [1, 2];
      break;
    case 4:
      upright = [2, 2];
      break;
    case 6:
      upright = [2, 3];
      break;
    case 9:
      upright = [3, 3];
      break;
    case 16:
      upright = [4, 4];
      break;
    default:
      upright = [1, 1];
  }
  const [cols, rows] = landscape ? [upright[1], upright[0]] : upright;
  return { cols, rows };
}

/**
 * The sides of a saddle-stitch booklet of `count` pages, as [left, right] pairs of
 * 0-based positions in the sequence, in printing order (front, back, front, …).
 * The pages are padded with blanks (`null`) to a multiple of four, then folded
 * from the outside in: for n padded pages the sides are [n,1], [2,n−1], [n−2,3],
 * [4,n−3] …. Printed two-sided and flipped on the short edge, the sheets nest and
 * fold into a booklet that reads 1…n.
 */
export function bookletSides(count: number): [number | null, number | null][] {
  if (count <= 0) return [];
  const n = Math.ceil(count / 4) * 4;
  const at = (page: number): number | null => (page <= count ? page - 1 : null);
  const sides: [number | null, number | null][] = [];
  for (let i = 0; i < n / 4; i++) {
    sides.push([at(n - 2 * i), at(1 + 2 * i)]);
    sides.push([at(2 + 2 * i), at(n - 1 - 2 * i)]);
  }
  return sides;
}

/** One planned sheet: the sequence position in each cell, row by row; `null` is a
 *  blank cell (the padding of a booklet or the tail of the last N-up sheet). */
export type PlannedSheet = (number | null)[];

export interface ImpositionPlan {
  cols: number;
  rows: number;
  sheets: PlannedSheet[];
}

/**
 * Which of `count` sequence positions goes where. `landscape` is the sheet's
 * orientation (a booklet is always landscape, whatever the caller says). One page
 * per sheet is the identity — one sheet per position.
 */
export function planImposition(count: number, mode: ImposeMode, landscape: boolean): ImpositionPlan {
  if (count <= 0) return { cols: 1, rows: 1, sheets: [] };
  if (mode.booklet) {
    return { cols: 2, rows: 1, sheets: bookletSides(count) };
  }
  const per = pagesPerSheet(mode);
  const { cols, rows } = gridFor(per, landscape);
  const sheets: PlannedSheet[] = [];
  for (let first = 0; first < count; first += per) {
    sheets.push(Array.from({ length: per }, (_, i) => (first + i < count ? first + i : null)));
  }
  return { cols, rows, sheets };
}

/** The physical sheets (sides) the print takes, one copy. */
export function sheetCount(count: number, mode: ImposeMode): number {
  return planImposition(count, mode, false).sheets.length;
}

export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The cells of a `cols`×`rows` grid filling a `width`×`height` area, a `gutter`
 * apart, in reading order (index = row × cols + col). Origin is the area's lower
 * left with y up, as a PDF page has it; row 0 is the top row.
 */
export function cellRects(
  cols: number,
  rows: number,
  width: number,
  height: number,
  gutter: number,
): CellRect[] {
  const w = Math.max(1, (width - (cols - 1) * gutter) / cols);
  const h = Math.max(1, (height - (rows - 1) * gutter) / rows);
  const rects: CellRect[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      rects.push({ x: c * (w + gutter), y: (rows - 1 - r) * (h + gutter), w, h });
    }
  }
  return rects;
}

/** Whether pages are turned to fit their cell: only two and six to a sheet, where
 *  the cells are the sheet's shape turned (the usual 2-up on an upright sheet).
 *  The other grids keep the pages the way the sheet is. */
export function autoTurns(mode: ImposeMode): boolean {
  if (mode.booklet) return false;
  const per = pagesPerSheet(mode);
  return per === 2 || per === 6;
}

/** A page of `contentW`×`contentH` (after any turn of its own) in a cell of
 *  `cellW`×`cellH`: 270 — a quarter turn the way a 2-up stack reads, the first
 *  page on the left once the sheet is turned — when that fills the cell clearly
 *  better (by over 10%, so a near-square cell does not flip pages by a hair), else 0. */
export function autoTurn(contentW: number, contentH: number, cellW: number, cellH: number): 0 | 270 {
  if (!(contentW > 0 && contentH > 0 && cellW > 0 && cellH > 0)) return 0;
  const upright = Math.min(cellW / contentW, cellH / contentH);
  const turned = Math.min(cellW / contentH, cellH / contentW);
  return turned > upright * 1.1 ? 270 : 0;
}
