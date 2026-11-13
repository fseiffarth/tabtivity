// The print preview's sheets, laid out as a real PDF.
//
// The preview (`printDocument`) shows a PDF as page images, because the webview
// has no PDF engine; printing those images is what made PDF printouts soft. With
// a native print path (`printPdfNative`) the preview is only the *picture* of the
// job: what it arranged — order, dropped and turned sheets, page selection,
// copies — and what it set — paper, margins, scale, page numbers — is rebuilt
// here onto the document's own pages, each placed as a form XObject, so text and
// vector art reach the printer as they are in the file.
//
// The geometry mirrors the preview's paged stylesheet (`buildOptionsCss`): the
// sheet is the paper minus the margin on every side; the page is fitted into it
// on its binding axis, capped at `scale` percent, and centred; a page number
// takes a 16 px band above the bottom margin and sits centred in it.
//
// Several pages to a sheet, or a booklet (`printImposition`), only change what
// the box above is: the sheet's printable area is cut into a grid of cells and
// each page is fitted into its own cell by the same rules — the page number
// band, the scale cap and the centring are per cell.

import { PDFDocument, StandardFonts, degrees, rgb, type PDFEmbeddedPage } from "pdf-lib";
import { MARGIN_CM, clampCopies, clampScale, pageBoxCm, type PrintOptions } from "./print";
import {
  GUTTER_CM,
  autoTurn,
  autoTurns,
  cellRects,
  isImposed,
  planImposition,
} from "./printImposition";

const PT_PER_CM = 72 / 2.54;
/** The preview's page-number band and font: 16 px and 10 px, in points. */
const NUMBER_BAND_PT = 12;
const NUMBER_SIZE_PT = 7.5;

/** One printed sheet: a 1-based page of the source PDF, and the turn the
 *  preview's strip added to it (clockwise degrees, a multiple of 90). */
export interface PrintSheet {
  page: number;
  rot: number;
}

/** Where to draw a page, scaled by `k`, so that after a clockwise `turn` its
 *  bounding box has its lower-left corner at (`bx`, `by`). pdf-lib rotates
 *  counter-clockwise about the drawing origin, hence the origin moves to the
 *  corner the turn carries onto the box's lower left. Exported for its tests. */
export function turnedOrigin(
  turn: number,
  bx: number,
  by: number,
  w: number,
  h: number,
): { x: number; y: number } {
  switch (turn) {
    case 90:
      return { x: bx, y: by + w };
    case 180:
      return { x: bx + w, y: by + h };
    case 270:
      return { x: bx + h, y: by };
    default:
      return { x: bx, y: by };
  }
}

/**
 * Lay `sheets` (print order, the preview's `printSequence`) out of `bytes` onto
 * paper as `opts` sets it — one page per sheet, several to a sheet, or a booklet
 * — `opts.copies` times collated: the document the preview shows, as a PDF.
 */
export async function layoutPrintPdf(
  bytes: Uint8Array,
  sheets: readonly PrintSheet[],
  opts: PrintOptions,
): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const [wCm, hCm] = pageBoxCm(opts);
  const paperW = wCm * PT_PER_CM;
  const paperH = hCm * PT_PER_CM;
  const pad = (MARGIN_CM[opts.margin] ?? MARGIN_CM.normal) * PT_PER_CM;
  const band = opts.pageNumbers ? NUMBER_BAND_PT : 0;
  const fill = clampScale(opts.scale) / 100;
  const font = opts.pageNumbers ? await out.embedFont(StandardFonts.Helvetica) : null;

  // The sheets of one copy: which sequence position lands in which cell.
  const plan = planImposition(sheets.length, opts, paperW > paperH);
  const cells = cellRects(
    plan.cols,
    plan.rows,
    Math.max(1, paperW - 2 * pad),
    Math.max(1, paperH - 2 * pad),
    isImposed(opts) ? GUTTER_CM * PT_PER_CM : 0,
  );
  const turnsToFit = autoTurns(opts);

  const pages = src.getPages();
  // One XObject per source page, shared by every copy that prints it.
  const embedded = new Map<number, PDFEmbeddedPage>();
  const copies = clampCopies(opts.copies);
  for (let copy = 0; copy < copies; copy++) {
    for (const planned of plan.sheets) {
      const used = planned.filter((at) => at !== null && pages[sheets[at]!.page - 1]);
      if (used.length === 0) continue;
      const page = out.addPage([paperW, paperH]);
      for (const [k, at] of planned.entries()) {
        const sheet = at === null ? undefined : sheets[at];
        const from = sheet ? pages[sheet.page - 1] : undefined;
        if (!sheet || !from) continue;
        let cached = embedded.get(sheet.page);
        if (!cached) {
          // The crop box is what a reader shows and what the preview pictured.
          const crop = from.getCropBox();
          cached = await out.embedPage(from, {
            left: crop.x,
            bottom: crop.y,
            right: crop.x + crop.width,
            top: crop.y + crop.height,
          });
          embedded.set(sheet.page, cached);
        }
        const emb = cached;
        const cell = cells[k]!;
        const boxW = cell.w;
        const boxH = Math.max(1, cell.h - band);
        // The page's own /Rotate plus the strip's turn, both clockwise — an embedded
        // page is its unrotated content, so the whole turn is applied here.
        let turn = (((from.getRotation().angle + sheet.rot) % 360) + 360) % 360;
        const sized = (t: number) => (t === 90 || t === 270 ? [emb.height, emb.width] : [emb.width, emb.height]);
        if (turnsToFit) {
          const [w0, h0] = sized(turn);
          turn = (turn + autoTurn(w0!, h0!, boxW, boxH)) % 360;
        }
        const [contentW, contentH] = sized(turn) as [number, number];
        const fit = Math.min(boxW / contentW, boxH / contentH) * fill;
        const bx = pad + cell.x + (boxW - contentW * fit) / 2;
        const by = pad + cell.y + band + (boxH - contentH * fit) / 2;
        page.drawPage(emb, {
          ...turnedOrigin(turn, bx, by, emb.width * fit, emb.height * fit),
          xScale: fit,
          yScale: fit,
          rotate: degrees(-turn),
        });
        if (font) {
          // Numbered per copy, each copy being a whole document — as the preview does.
          const label = String(at! + 1);
          page.drawText(label, {
            x: pad + cell.x + (cell.w - font.widthOfTextAtSize(label, NUMBER_SIZE_PT)) / 2,
            y: pad + cell.y + NUMBER_SIZE_PT * 0.25,
            size: NUMBER_SIZE_PT,
            font,
            color: rgb(0x55 / 255, 0x55 / 255, 0x55 / 255),
          });
        }
      }
    }
    // Two-sided: a copy with an odd number of sides would hand its last sheet's
    // back to the next copy's first page. A blank side keeps every copy whole.
    if (opts.duplex !== "none" && copy < copies - 1 && plan.sheets.length % 2 === 1) {
      out.addPage([paperW, paperH]);
    }
  }
  if (out.getPageCount() === 0) throw new Error("nothing to print");
  return out.save();
}
