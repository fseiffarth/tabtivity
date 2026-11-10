/**
 * `layoutPrintPdf` with imposition — several pages to a sheet and the booklet,
 * checked on the PDF that would go to the printer: how many sides, which source
 * page is in which cell, and that nothing leaves the paper.
 */
import { describe, it, expect } from "vitest";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  decodePDFRawStream,
} from "pdf-lib";
import { layoutPrintPdf } from "../../lib/viewers/pdfPrintLayout";
import { PAGED_PRINT_OPTIONS, type PrintOptions } from "../../lib/viewers/print";

const opts = (over: Partial<PrintOptions> = {}): PrintOptions => ({ ...PAGED_PRINT_OPTIONS, ...over });

/** A source of `n` upright pages, page k being 100·k pt wide and 400 tall — so
 *  the width of a placed form says which page it is. */
async function numbered(n: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let k = 1; k <= n; k++) {
    // Something to draw: pdf-lib will not embed a page with no content.
    doc.addPage([100 * k, 400]).drawRectangle({ x: 10, y: 10, width: 20, height: 20 });
  }
  return doc.save();
}

const seq = (...pages: number[]): { page: number; rot: number }[] =>
  pages.map((page) => ({ page, rot: 0 }));

const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

/** What one output sheet draws: per placed page, the width of its source page and
 *  the matrix `a b c d e f` it was placed with. */
function placed(doc: PDFDocument, sheet: number) {
  const page = doc.getPage(sheet);
  const contents = page.node.Contents();
  if (!(contents instanceof PDFArray)) throw new Error("no page content");
  const text = contents
    .asArray()
    .map((ref) => decodePDFRawStream(doc.context.lookup(ref) as PDFRawStream).decode())
    .map((bytes) => new TextDecoder("latin1").decode(bytes))
    .join("\n");
  const xobjects = page.node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
  const out: { srcWidth: number; m: number[] }[] = [];
  // pdf-lib draws a page as `q`, a translate, a rotate and a scale (one `cm` each),
  // then `/Name Do` and `Q`: fold the matrices into the one they amount to.
  for (const match of text.matchAll(/q((?:\s+[-\d.e]+){6}\s+cm)+\s+\/(\S+)\s+Do/g)) {
    const ctm = [1, 0, 0, 1, 0, 0];
    for (const cm of match[0].matchAll(/((?:[-\d.e]+\s+){5}[-\d.e]+)\s+cm/g)) {
      const [a, b, c, d, e, f] = cm[1]!.trim().split(/\s+/).map(Number) as [
        number, number, number, number, number, number,
      ];
      const [A, B, C, D, E, F] = ctm as [number, number, number, number, number, number];
      // CTM′ = M × CTM
      ctm.splice(0, 6, a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D,
        e * A + f * C + E, e * B + f * D + F);
    }
    const form = xobjects.lookup(PDFName.of(match[2]!)) as PDFRawStream;
    const bbox = form.dict.lookup(PDFName.of("BBox"), PDFArray);
    out.push({ srcWidth: Math.round(bbox.lookup(2, PDFNumber).asNumber()), m: ctm });
  }
  return out;
}

const widths = (doc: PDFDocument, sheet: number) => placed(doc, sheet).map((p) => p.srcWidth / 100);

describe("layoutPrintPdf — several pages to a sheet", () => {
  it("puts N pages on each sheet, in reading order", async () => {
    const out = await PDFDocument.load(
      await layoutPrintPdf(await numbered(5), seq(...upTo(5)), opts({ nup: 4 })),
    );
    expect(out.getPageCount()).toBe(2);
    expect(widths(out, 0)).toEqual([1, 2, 3, 4]);
    expect(widths(out, 1)).toEqual([5]);
  });

  it("places the cells left to right, then top to bottom", async () => {
    const out = await PDFDocument.load(
      await layoutPrintPdf(await numbered(4), seq(...upTo(4)), opts({ nup: 4 })),
    );
    const [a, b, c, d] = placed(out, 0).map((p) => ({ x: p.m[4]!, y: p.m[5]! }));
    expect(a!.x).toBeLessThan(b!.x);
    expect(a!.y).toBeCloseTo(b!.y, 3);
    expect(c!.x).toBeLessThan(d!.x);
    expect(c!.y).toBeLessThan(a!.y);
  });

  it("keeps every page inside the paper", async () => {
    for (const nup of [2, 4, 6, 9, 16] as const) {
      const out = await PDFDocument.load(
        await layoutPrintPdf(await numbered(16), seq(...upTo(16)), opts({ nup })),
      );
      expect(out.getPageCount()).toBe(Math.ceil(16 / nup));
      for (let s = 0; s < out.getPageCount(); s++) {
        const { width, height } = out.getPage(s).getSize();
        for (const p of placed(out, s)) {
          expect(p.m[4]!).toBeGreaterThanOrEqual(-0.5);
          expect(p.m[5]!).toBeGreaterThanOrEqual(-0.5);
          expect(p.m[4]!).toBeLessThanOrEqual(width + 0.5);
          expect(p.m[5]!).toBeLessThanOrEqual(height + 0.5);
        }
      }
    }
  });

  it("turns upright pages into the landscape cells of a 2-up", async () => {
    const out = await PDFDocument.load(
      await layoutPrintPdf(await numbered(2), seq(1, 2), opts({ nup: 2 })),
    );
    // A quarter turn has no a/d terms in its matrix, only b/c.
    for (const p of placed(out, 0)) {
      expect(Math.abs(p.m[0]!)).toBeLessThan(1e-6);
      expect(Math.abs(p.m[1]!)).toBeGreaterThan(0);
    }
  });

  it("leaves pages upright in a 4-up", async () => {
    const out = await PDFDocument.load(
      await layoutPrintPdf(await numbered(4), seq(...upTo(4)), opts({ nup: 4 })),
    );
    for (const p of placed(out, 0)) expect(Math.abs(p.m[1]!)).toBeLessThan(1e-6);
  });

  it("applies the page selection and order before it imposes", async () => {
    const out = await PDFDocument.load(
      await layoutPrintPdf(await numbered(5), seq(5, 3, 1), opts({ nup: 2 })),
    );
    expect(out.getPageCount()).toBe(2);
    expect(widths(out, 0)).toEqual([5, 3]);
    expect(widths(out, 1)).toEqual([1]);
  });

  it("collates copies over the whole imposed job", async () => {
    const out = await PDFDocument.load(
      await layoutPrintPdf(await numbered(3), seq(1, 2, 3), opts({ nup: 2, copies: 2 })),
    );
    expect(out.getPageCount()).toBe(4);
    expect(widths(out, 2)).toEqual([1, 2]);
  });

  it("numbers pages in their cells without losing any", async () => {
    const bytes = await layoutPrintPdf(
      await numbered(4),
      seq(...upTo(4)),
      opts({ nup: 4, pageNumbers: true }),
    );
    const out = await PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(1);
    expect(widths(out, 0)).toEqual([1, 2, 3, 4]);
  });

  it("is unchanged at one page per sheet", async () => {
    const out = await PDFDocument.load(
      await layoutPrintPdf(await numbered(3), seq(3, 1), opts({ nup: 1 })),
    );
    expect(out.getPageCount()).toBe(2);
    expect(widths(out, 0)).toEqual([3]);
    expect(widths(out, 1)).toEqual([1]);
  });
});

describe("layoutPrintPdf — booklet", () => {
  it("imposes eight pages as [8,1] [2,7] [6,3] [4,5] on landscape sides", async () => {
    const out = await PDFDocument.load(
      await layoutPrintPdf(await numbered(8), seq(...upTo(8)), opts({ booklet: true })),
    );
    expect(out.getPageCount()).toBe(4);
    for (const page of out.getPages()) {
      const { width, height } = page.getSize();
      expect(width).toBeGreaterThan(height);
    }
    expect([0, 1, 2, 3].map((s) => widths(out, s))).toEqual([
      [8, 1],
      [2, 7],
      [6, 3],
      [4, 5],
    ]);
  });

  it("pads with blanks to a multiple of four", async () => {
    const out = await PDFDocument.load(
      await layoutPrintPdf(await numbered(5), seq(...upTo(5)), opts({ booklet: true })),
    );
    expect(out.getPageCount()).toBe(4);
    expect(widths(out, 0)).toEqual([1]);
    expect(widths(out, 3)).toEqual([4, 5]);
  });

  it("is landscape even when asked for upright, and wins over N-up", async () => {
    const out = await PDFDocument.load(
      await layoutPrintPdf(
        await numbered(4),
        seq(...upTo(4)),
        opts({ booklet: true, nup: 9, orientation: "portrait" }),
      ),
    );
    expect(out.getPageCount()).toBe(2);
    expect(out.getPage(0).getWidth()).toBeGreaterThan(out.getPage(0).getHeight());
  });

  it("orders the pages of the arrangement, not of the file", async () => {
    // The strip put page 4 first: it is the booklet's first page.
    const out = await PDFDocument.load(
      await layoutPrintPdf(await numbered(4), seq(4, 1, 2, 3), opts({ booklet: true })),
    );
    expect(widths(out, 0)).toEqual([3, 4]);
    expect(widths(out, 1)).toEqual([1, 2]);
  });

  it("repeats a whole booklet per copy", async () => {
    const out = await PDFDocument.load(
      await layoutPrintPdf(
        await numbered(4),
        seq(...upTo(4)),
        opts({ booklet: true, copies: 3, duplex: "short" }),
      ),
    );
    expect(out.getPageCount()).toBe(6);
  });
});

describe("layoutPrintPdf — two-sided copies", () => {
  const count = async (pages: number[], over: Partial<PrintOptions>) =>
    (
      await PDFDocument.load(
        await layoutPrintPdf(await numbered(3), seq(...pages), opts(over)),
      )
    ).getPageCount();

  it("keeps each copy whole by padding an odd run with a blank side", async () => {
    expect(await count([1, 2, 3], { copies: 2, duplex: "none" })).toBe(6);
    expect(await count([1, 2, 3], { copies: 2, duplex: "long" })).toBe(7);
    expect(await count([1, 2, 3], { copies: 2, duplex: "short" })).toBe(7);
  });

  it("adds nothing to an even run or a single copy", async () => {
    expect(await count([1, 2], { copies: 3, duplex: "long" })).toBe(6);
    expect(await count([1, 2, 3], { copies: 1, duplex: "long" })).toBe(3);
  });
});
