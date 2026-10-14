/**
 * What the PDF viewer relies on IN pdf.js itself — run against the real library.
 *
 * Every other PDF test drives our code with a hand-written fake of pdf.js, so a
 * bump that renames a field we read, moves a destination's slot or stops
 * sanitising a URL keeps all of them green. These tests open a small hand-built
 * PDF (`helpers/pdfFixture.ts`) with the real parser and send it through our own
 * readers — the outline, the links, the remarks, the text boxes, the repaint
 * fingerprint and the loader — so the shapes they consume are the bumped
 * version's own. (The `legacy` build of the same version; see `realPdfjs.ts`.)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("pdfjs-dist", () => import("../helpers/realPdfjs"));

import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { assemblePdf, onePagePdf, stream } from "../helpers/pdfFixture";
import { PdfWorkerSlot, loadPdf } from "../../lib/viewers/pdfLoad";
import { loadOutline, resolveDest } from "../../components/embed/pdf/outline";
import { destTopInBigPoints, loadPageLinks } from "../../components/embed/pdf/links";
import { loadPageNotes } from "../../components/embed/pdf/notes";
import { pageTextItemBoxes, pageTextItemBoxesUnturned } from "../../components/embed/pdf/pageText";
import { fingerprintPage, samePage } from "../../components/embed/pdf/pageFingerprint";

/**
 * Two pages, the second turned by its own `/Rotate 90`. Page 1 carries every
 * link kind `links.ts` sorts (an `https` URI, a named and an explicit internal
 * destination, a `javascript:` URI and a `Launch`), a sticky note and a
 * highlight whose quads are written bottom-left first; the outline has a named
 * and an explicit destination and one nested entry.
 */
function paperPdf(): Uint8Array {
  return assemblePdf([
    /* 1 */ "<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R" +
      " /Names << /Dests << /Names [(sec.results) [4 0 R /XYZ 0 500 null]] >> >> >>",
    /* 2 */ "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    /* 3 */ "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R" +
      " /Resources << /Font << /F1 7 0 R >> >> /Annots [12 0 R 13 0 R 14 0 R 15 0 R 16 0 R 17 0 R 18 0 R] >>",
    /* 4 */ "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate 90 /Contents 6 0 R" +
      " /Resources << /Font << /F1 7 0 R >> >> /Annots [19 0 R] >>",
    /* 5 */ stream("", "BT /F1 24 Tf 72 700 Td (Introduction) Tj ET\nBT /F1 12 Tf 72 650 Td (See the results) Tj ET"),
    /* 6 */ stream("", "BT /F1 24 Tf 72 500 Td (Results) Tj ET"),
    /* 7 */ "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    /* 8 */ "<< /Type /Outlines /First 9 0 R /Last 10 0 R /Count 2 >>",
    /* 9 */ "<< /Title (Introduction) /Parent 8 0 R /Next 10 0 R /Dest [3 0 R /XYZ 72 720 null] >>",
    /* 10 */ "<< /Title (Results) /Parent 8 0 R /Prev 9 0 R /Dest (sec.results) /First 11 0 R /Last 11 0 R /Count 1 >>",
    /* 11 */ "<< /Title (Detail) /Parent 10 0 R /Dest [4 0 R /Fit] >>",
    /* 12 */ "<< /Type /Annot /Subtype /Link /Rect [72 645 120 660] /A << /S /URI /URI (https://example.org/paper) >> >>",
    /* 13 */ "<< /Type /Annot /Subtype /Link /Rect [120 645 150 660] /Dest (sec.results) >>",
    /* 14 */ "<< /Type /Annot /Subtype /Link /Rect [72 645 100 660] /A << /S /URI /URI (javascript:alert\\(1\\)) >> >>",
    /* 15 */ "<< /Type /Annot /Subtype /Link /Rect [100 645 140 660] /Dest [4 0 R /FitH 400] >>",
    /* 16 */ "<< /Type /Annot /Subtype /Link /Rect [72 695 120 720] /A << /S /Launch /F (calc.exe) >> >>",
    /* 17 */ "<< /Type /Annot /Subtype /Text /Rect [300 700 320 720] /Contents (Check this) /T (Reviewer)" +
      " /C [1 0 0] /Name /Comment /M (D:20260101120000Z) /CreationDate (D:20251231120000Z) >>",
    /* 18 */ "<< /Type /Annot /Subtype /Highlight /Rect [72 696 200 722]" +
      " /QuadPoints [72 696 200 696 72 722 200 722] /Contents (marked) /C [1 1 0] >>",
    /* 19 */ "<< /Type /Annot /Subtype /Link /Rect [72 495 150 520] /A << /S /URI /URI (https://example.org/rotated) >> >>",
  ]);
}

let doc: PDFDocumentProxy;

beforeAll(async () => {
  doc = await loadPdf(paperPdf());
});

afterAll(async () => {
  await doc.loadingTask.destroy();
});

describe("worker setup", () => {
  it("points pdf.js at the bundled worker asset, not its own default", () => {
    // `pdfLoad` is the one place this is set; without it a worker-less pdf.js
    // parses on the UI thread (the black projector of a 300-page deck).
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toMatch(/pdfjs-dist\/build\/pdf\.worker\.min\.mjs$/);
  });
});

describe("loadPdf against the real parser", () => {
  it("rejects a file cut off mid-write — the viewer's reload retry depends on it", async () => {
    // A LaTeX build rewrites the PDF in place; the viewer retries only on a
    // rejected load. A recovered half-document would be shown and never retried.
    const whole = paperPdf();
    await expect(loadPdf(whole.slice(0, Math.floor(whole.length * 0.6)))).rejects.toMatchObject({
      name: "InvalidPDFException",
    });
  });

  it("a slot's worker survives one document's teardown and serves the next", async () => {
    const slot = new PdfWorkerSlot();
    const worker = slot.get()!;
    const first = await loadPdf(onePagePdf("one"), worker);
    await first.loadingTask.destroy();
    // pdf.js leaves a worker it was handed alone when the document goes — the
    // whole point of the slot (one worker across a LaTeX session's reloads).
    expect(worker.destroyed).toBe(false);
    expect(slot.get()).toBe(worker);
    const second = await loadPdf(onePagePdf("two"), worker);
    expect(second.numPages).toBe(1);
    await second.loadingTask.destroy();
    slot.dispose();
  });

  it("a slot whose worker was destroyed under it starts a fresh one", async () => {
    const slot = new PdfWorkerSlot();
    const dead = slot.get()!;
    await dead.promise;
    dead.destroy();
    expect(dead.destroyed).toBe(true);
    const fresh = slot.get()!;
    expect(fresh).not.toBe(dead);
    const opened = await loadPdf(onePagePdf("again"), fresh);
    expect(opened.numPages).toBe(1);
    await opened.loadingTask.destroy();
    slot.dispose();
  });
});

describe("outline (outline.ts)", () => {
  it("resolves named and explicit destinations to 1-based file pages, nesting kept", async () => {
    const tree = await loadOutline(doc);
    expect(tree).toEqual([
      { id: "0", title: "Introduction", page: 1, children: [] },
      {
        id: "1",
        title: "Results",
        page: 2,
        children: [{ id: "1.0", title: "Detail", page: 2, children: [] }],
      },
    ]);
  });

  it("reads the y anchor out of a named /XYZ destination", async () => {
    await expect(resolveDest(doc, "sec.results")).resolves.toEqual({ page: 2, top: 500 });
    await expect(resolveDest(doc, "no.such.anchor")).resolves.toBeNull();
  });
});

describe("links (links.ts)", () => {
  it("keeps the http(s) URI and both internal kinds, drops javascript: and Launch", async () => {
    const links = await loadPageLinks(doc, 1);
    const external = links.filter((l) => l.kind === "external");
    const internal = links.filter((l) => l.kind === "internal");
    // pdf.js fills `url` only for a scheme it accepts; `javascript:` arrives as
    // `unsafeUrl` alone and the Launch has no `url` either — both dropped.
    expect(external.map((l) => l.kind === "external" && l.url)).toEqual(["https://example.org/paper"]);
    expect(internal.map((l) => l.kind === "internal" && l.dest)).toEqual([
      { page: 2, top: 500 }, // named `sec.results`, /XYZ
      { page: 2, top: 400 }, // explicit [page /FitH 400]
    ]);
    expect(links).toHaveLength(3);
  });

  it("boxes a link in big points from the page's top-left", async () => {
    const [uri] = await loadPageLinks(doc, 1);
    expect(uri.rect).toEqual({ page: 1, x: 72, y: 792 - 660, w: 48, h: 15 });
  });

  it("measures a link on a /Rotate 90 page in the turned space the canvas is painted in", async () => {
    const [link] = await loadPageLinks(doc, 2);
    expect(link).toMatchObject({ kind: "external", url: "https://example.org/rotated" });
    // Turned a quarter clockwise the sheet is 792 wide: PDF y becomes screen x,
    // PDF x becomes screen y — the 78 × 25 box stands 25 wide and 78 tall.
    expect(link.rect).toEqual({ page: 2, x: 495, y: 72, w: 25, h: 78 });
  });

  it("places a destination's anchor on the target page", async () => {
    await expect(destTopInBigPoints(doc, { page: 2, top: 400 })).resolves.toBeCloseTo(0, 5);
    const page2 = await doc.getPage(2);
    expect(page2.rotate).toBe(90);
    // Unturned (viewer turn of -90 cancels the page's own), y flips from the bottom.
    await expect(destTopInBigPoints(doc, { page: 2, top: 400 }, -90)).resolves.toBeCloseTo(792 - 400, 5);
  });
});

describe("remarks (notes.ts)", () => {
  it("reads a sticky note's text, author, colour, icon and dates", async () => {
    const notes = await loadPageNotes(doc, 1);
    const sticky = notes.find((n) => !n.quads)!;
    expect(sticky).toMatchObject({
      text: "Check this",
      author: "Reviewer",
      color: [1, 0, 0],
      icon: "Comment",
      created: "D:20251231120000Z",
      modified: "D:20260101120000Z",
    });
  });

  it("reads a highlight's quads, normalised, plus the id the render suppresses it by", async () => {
    const notes = await loadPageNotes(doc, 1);
    const hl = notes.find((n) => n.quads)!;
    expect(hl.text).toBe("marked");
    expect(hl.color).toEqual([1, 1, 0]);
    expect(hl.quads).toEqual([{ x: 72, y: 792 - 722, w: 128, h: 26 }]);
    expect(hl.srcId).toEqual(expect.any(String));
  });

  it("a highlight suppressed by id in annotationStorage is not painted under ENABLE_STORAGE", async () => {
    // The viewer draws a highlight it has read itself and hides the file's copy
    // with `annotationStorage.setValue(srcId, { noView: true })` — honoured only in
    // AnnotationMode.ENABLE_STORAGE (`PdfViewer`'s ANNOT_MODE, `pdfDoc`'s redact
    // raster). Counted on the operator list, which is what a render paints.
    const own = await loadPdf(paperPdf());
    try {
      const page = await own.getPage(1);
      const painted = async () =>
        (await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.ENABLE_STORAGE })).fnArray.filter(
          (fn) => fn === pdfjs.OPS.beginAnnotation,
        ).length;
      const before = await painted();
      const hl = (await loadPageNotes(own, 1)).find((n) => n.quads)!;
      own.annotationStorage.setValue(hl.srcId!, { noView: true });
      expect(await painted()).toBe(before - 1);
    } finally {
      await own.loadingTask.destroy();
    }
  });
});

describe("text boxes (pageText.ts)", () => {
  it("boxes each run on its glyph band, width from the font's own advances", async () => {
    const boxes = await pageTextItemBoxes(doc, 1);
    expect(boxes.map((b) => b.str)).toEqual(["Introduction", "See the results"]);
    const [title] = boxes;
    // 24pt baseline at y=700: top = 792 - 700 - 0.8·24, height one em.
    expect(title.x).toBeCloseTo(72, 5);
    expect(title.y).toBeCloseTo(792 - 700 - 19.2, 5);
    expect(title.h).toBeCloseTo(24, 5);
    // Helvetica "Introduction" is 5225 units wide at 1000/em.
    expect(title.w).toBeCloseTo(5.225 * 24, 3);
  });

  it("measures a turned page's runs in the turned space, and the unturned ones in its own", async () => {
    const [turned] = await pageTextItemBoxes(doc, 2);
    const [flat] = await pageTextItemBoxesUnturned(doc, 2);
    expect(flat.x).toBeCloseTo(72, 5);
    expect(flat.y).toBeCloseTo(792 - 500 - 19.2, 5);
    // A quarter turn clockwise sends PDF y (500) to screen x.
    expect(turned.x).toBeCloseTo(500, 5);
    expect(turned.y).toBeCloseTo(72 - 19.2, 5);
  });
});

describe("painting a soft-masked group (the beamer block shadow)", () => {
  // Why the pin is `^6`: 4.x/5.x painted a beamer block's shadow — a pgf
  // luminosity soft mask whose `/CS /DeviceGray` group ends in a black `re f`
  // that masks the block interior OUT — as an opaque black bar. Drawn here with
  // the same shape: blue through a mask that is white on a ring and black inside
  // it, so only the ring may turn blue. Painted on the canvas pdf.js itself
  // makes outside a browser.
  function shadowPdf(): Uint8Array {
    return assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Contents 4 0 R" +
        " /Resources << /ExtGState << /GS1 5 0 R >> >> >>",
      stream("", "q /GS1 gs 0 0 1 rg 100 100 200 200 re f Q"),
      "<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G 6 0 R >> >>",
      stream(
        "/Type /XObject /Subtype /Form /BBox [0 0 400 400] /Group << /S /Transparency /CS /DeviceGray >>",
        "1 g 100 100 200 200 re f 0 g 150 150 100 100 re f",
      ),
    ]);
  }

  interface Canvas2d {
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
  }

  it("shows the masked content only where the mask is white", async () => {
    const shadow = await loadPdf(shadowPdf());
    try {
      const page = await shadow.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      const { canvas, context } = (shadow.canvasFactory as { create(w: number, h: number): Canvas2d }).create(400, 400);
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, 400, 400);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      // PDF y runs up, the canvas's down.
      const rgb = (x: number, y: number) => Array.from(context.getImageData(x, 400 - y, 1, 1).data.slice(0, 3));
      expect(rgb(120, 120)).toEqual([0, 0, 255]); // the ring: mask white, blue shows
      expect(rgb(200, 200)).toEqual([255, 255, 255]); // the block interior: masked out
      expect(rgb(50, 50)).toEqual([255, 255, 255]); // outside the group: untouched
    } finally {
      await shadow.loadingTask.destroy();
    }
  });
});

describe("repaint fingerprint (pageFingerprint.ts)", () => {
  it("summarises a real page, the same every time it is asked", async () => {
    const page = await doc.getPage(1);
    const a = await fingerprintPage(page);
    // A null (pdf.js changed the operator list's shape) would silently turn
    // every reload into a full repaint.
    expect(a).toMatch(/^[1-9]\d*:[0-9a-f]+$/);
    expect(samePage(a, await fingerprintPage(page))).toBe(true);
  });

  it("tells different pages, and a turned sheet from itself, apart", async () => {
    const p1 = await doc.getPage(1);
    const one = await fingerprintPage(p1);
    expect(samePage(one, await fingerprintPage(await doc.getPage(2)))).toBe(false);
    // Half a turn keeps the sheet's size, so only the turn itself can tell them apart.
    expect(samePage(one, await fingerprintPage(p1, 180))).toBe(false);
  });
});
