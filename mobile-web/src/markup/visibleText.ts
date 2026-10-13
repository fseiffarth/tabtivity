/**
 * The text runs a reader can see on the drawn page — the only ones a mark's
 * words may come from (`anchors.ts`).
 *
 * A PDF's text content lists every run the file names, the ones nobody sees
 * too: render mode 3, white on white, a run off the page, a hair-thin line.
 * The words under a mark go into the agent's prompt as the user's own, so a
 * hostile PDF could hide an instruction exactly where the user would mark.
 * pdf.js's text content says nothing of a run's colour or render mode, so the
 * test is on pixels: a run counts only where the page as drawn shows ink in
 * its box. An OCR'd scan keeps its words — its invisible text lies over the
 * scanned glyphs.
 *
 * Residual: an invisible run laid over other ink (a picture, a rule, or
 * visible text) still passes.
 *
 * Pure: the phone runs it in the sealed frame, the desktop in `markupPage.ts`.
 */

import type { TextRun } from "./findText";

/** A drawn page's RGBA pixels (`ImageData`'s shape). */
export type PagePixels = { width: number; height: number; data: Uint8ClampedArray };

/** Below this em, in page points, a run is not text anyone reads. */
export const MIN_VISIBLE_EM = 4;
/** A channel this far from the box's background value is ink. */
export const INK_DIFF = 40;
/** The share of a run's box that must be ink, and the fewest ink pixels. */
const INK_SHARE = 0.02;
const MIN_INK = 2;

/** `runs` (page points, top-left origin) without those `pixels` — the page
 * drawn `scale` pixels per point — show no ink for. Runs of white space stay:
 * they say nothing, and the line breaks they carry place the words. */
export function visibleRuns(runs: readonly TextRun[], pixels: PagePixels, scale: number): TextRun[] {
  if (!(scale > 0)) return [];
  return runs.filter((run) => !run.str.trim() || inked(run, pixels, scale));
}

function inked(run: TextRun, { width, height, data }: PagePixels, scale: number): boolean {
  if (!(run.h >= MIN_VISIBLE_EM) || !(run.w > 0)) return false;
  // The glyph band: cap height to just under the baseline (a run's box is
  // ascent over descent, the baseline 0.8 of the way down), so the lines
  // above and below stay out of it.
  const x0 = Math.max(0, Math.floor(run.x * scale));
  const x1 = Math.min(width, Math.ceil((run.x + run.w) * scale));
  const y0 = Math.max(0, Math.floor((run.y + 0.1 * run.h) * scale));
  const y1 = Math.min(height, Math.ceil((run.y + 0.95 * run.h) * scale));
  if (!(x1 > x0 && y1 > y0)) return false;
  // The background is each channel's commonest value in the box.
  const counts = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let y = y0; y < y1; y++) {
    for (let i = (y * width + x0) * 4, end = (y * width + x1) * 4; i < end; i += 4) {
      counts[0][data[i]]++;
      counts[1][data[i + 1]]++;
      counts[2][data[i + 2]]++;
    }
  }
  const bg = counts.map((count) => count.indexOf(Math.max(...count)));
  const area = (x1 - x0) * (y1 - y0);
  const needed = Math.max(MIN_INK, Math.ceil(INK_SHARE * area));
  let ink = 0;
  for (let y = y0; y < y1; y++) {
    for (let i = (y * width + x0) * 4, end = (y * width + x1) * 4; i < end; i += 4) {
      const off = Math.max(Math.abs(data[i] - bg[0]), Math.abs(data[i + 1] - bg[1]), Math.abs(data[i + 2] - bg[2]));
      if (off > INK_DIFF && ++ink >= needed) return true;
    }
  }
  return false;
}
