/**
 * Tests for the pure part of the viewer print pipeline (`lib/viewers/print`):
 * `buildPrintDoc` assembles a self-contained print document from a body + css.
 * The DOM driver (`printDocument`) and pdf.js rasteriser are exercised at
 * runtime, not here.
 *
 * The *arrangement* itself (moving/deleting/turning pages) now lives in the shared
 * `lib/viewers/pageModel` and is tested in `PageModel.test.ts`. What stays here is
 * the print-specific reading of an arrangement: `printSequence`.
 */
import { describe, it, expect } from "vitest";
import {
  buildPrintDoc,
  buildOptionsCss,
  parsePageRange,
  selectedPages,
  printSequence,
  withCopies,
  clampCopies,
  thumbSizePx,
  contentBoxCm,
  rasterScaleFor,
  PDF_PRINT_SCALE,
  loadPrintOptions,
  savePrintOptions,
  sanitizePrintOptions,
  DEFAULT_PRINT_OPTIONS,
  PAGED_PRINT_OPTIONS,
  TEXT_PRINT_CSS,
  MARKDOWN_PRINT_CSS,
  IMAGE_PRINT_CSS,
  type PrintOptions,
} from "../../lib/viewers/print";
import {
  initialPages,
  movePages,
  deletePages,
  type PageList,
} from "../../lib/viewers/pageModel";
import { storageKey } from "../../lib/brand";

const withOpts = (patch: Partial<PrintOptions>): PrintOptions => ({
  ...DEFAULT_PRINT_OPTIONS,
  ...patch,
});

describe("buildPrintDoc", () => {
  it("produces a complete, self-contained HTML document", () => {
    const doc = buildPrintDoc("<p>hi</p>", ".x{color:red}", "Note");
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain('<meta charset="utf-8">');
    expect(doc).toContain("<body><p>hi</p></body>");
    // Caller CSS is inlined into the <style> after the print base.
    expect(doc).toContain(".x{color:red}");
    // Print base: page margins so nothing prints edge-to-edge.
    expect(doc).toContain("@page{margin:1.5cm}");
  });

  it("sets and escapes the document title", () => {
    const doc = buildPrintDoc("", "", 'a"b & <c>');
    expect(doc).toContain("<title>a&quot;b &amp; &lt;c></title>");
  });

  it("defaults the title when none is given", () => {
    expect(buildPrintDoc("", "")).toContain("<title>Print</title>");
  });

  it("does not escape the body (caller-trusted markup)", () => {
    // The body is already sanitised/escaped by the caller (renderMarkdown or
    // escapeHtml), so buildPrintDoc must pass it through verbatim.
    const doc = buildPrintDoc('<pre class="print-pre">a &lt; b</pre>', TEXT_PRINT_CSS);
    expect(doc).toContain('<pre class="print-pre">a &lt; b</pre>');
  });

  it("exposes stylesheets targeting the expected structures", () => {
    expect(MARKDOWN_PRINT_CSS).toContain(".markdown-body");
    expect(TEXT_PRINT_CSS).toContain("pre.print-pre");
  });

  it("gives md/txt real print margins via body padding, not @page alone", () => {
    // WebKitGTK ignores the @page margin box, so margins must come from body
    // padding (honored by every engine). @page is zeroed so Chromium-based
    // WebView2 does not stack its own margin on top. Regression guard: these
    // margins previously existed only as @page and printed edge-to-edge.
    for (const css of [MARKDOWN_PRINT_CSS, TEXT_PRINT_CSS]) {
      expect(css).toContain("body{padding:2.54cm}");
      expect(css).toContain("@page{margin:0}");
    }
  });
});

describe("parsePageRange", () => {
  it("parses single pages, ranges and open-ended ranges", () => {
    expect(parsePageRange("1-3, 5", 10)).toEqual([1, 2, 3, 5]);
    expect(parsePageRange("2 4", 10)).toEqual([2, 4]);
    expect(parsePageRange("7-", 9)).toEqual([7, 8, 9]);
    expect(parsePageRange("-3", 9)).toEqual([1, 2, 3]);
  });

  it("clamps to the document, dedupes and sorts", () => {
    expect(parsePageRange("9, 2-4, 3, 0", 5)).toEqual([2, 3, 4]);
    // Reversed bounds are read as the range the user meant.
    expect(parsePageRange("4-2", 5)).toEqual([2, 3, 4]);
  });

  it("drops garbage instead of throwing (it runs on every keystroke)", () => {
    expect(parsePageRange("", 5)).toEqual([]);
    // "abc" and a bare "-" carry no page, so only the "2" survives.
    expect(parsePageRange("abc, 2, -, ,", 5)).toEqual([2]);
    expect(parsePageRange("1-2", 0)).toEqual([]);
  });
});

describe("selectedPages", () => {
  it("selects all / odd / even / a custom range", () => {
    expect(selectedPages(withOpts({ pages: "all" }), 4)).toEqual([1, 2, 3, 4]);
    expect(selectedPages(withOpts({ pages: "odd" }), 5)).toEqual([1, 3, 5]);
    expect(selectedPages(withOpts({ pages: "even" }), 5)).toEqual([2, 4]);
    expect(selectedPages(withOpts({ pages: "custom", range: "2-3" }), 5)).toEqual([2, 3]);
  });

  it("selects nothing in a document with no pages (a flowing document)", () => {
    expect(selectedPages(DEFAULT_PRINT_OPTIONS, 0)).toEqual([]);
  });
});

describe("what actually prints", () => {
  /** The arrangement as original page numbers, which is what lands on paper. */
  const printed = (list: PageList, opts: PrintOptions): number[] =>
    printSequence(list, opts).map((r) => r.page);

  it("prints the arrangement, with the selection counting arranged positions", () => {
    const three = initialPages(3);
    const arranged = movePages(three, [three[2].id], 0); // page 3 dragged to the front
    expect(arranged.map((r) => r.page)).toEqual([3, 1, 2]);

    expect(printed(arranged, withOpts({ pages: "all" }))).toEqual([3, 1, 2]);
    // "1-2" means the first two sheets *as arranged*, not original pages 1 and 2.
    expect(printed(arranged, withOpts({ pages: "custom", range: "1-2" }))).toEqual([3, 1]);
    expect(printed(arranged, withOpts({ pages: "odd" }))).toEqual([3, 2]);

    // Deleted pages are simply gone from the arrangement.
    const minusPage1 = deletePages(arranged, [three[0].id]);
    expect(printed(minusPage1, withOpts({ pages: "all" }))).toEqual([3, 2]);
  });

  it("prints nothing from an empty arrangement", () => {
    expect(printSequence([], DEFAULT_PRINT_OPTIONS)).toEqual([]);
  });

  it("prints copies collated, each one the whole sequence", () => {
    const seq = printSequence(initialPages(3), withOpts({ pages: "custom", range: "1-2" }));
    expect(withCopies(seq, 3).map((r) => r.page)).toEqual([1, 2, 1, 2, 1, 2]);
    expect(withCopies(seq, 1)).toEqual(seq);
    expect(withCopies([], 5)).toEqual([]);
  });

  it("clamps a copy count to a whole number a printer should get", () => {
    expect(clampCopies(0)).toBe(1);
    expect(clampCopies(-4)).toBe(1);
    expect(clampCopies(2.6)).toBe(3);
    expect(clampCopies(1e6)).toBe(99);
    expect(clampCopies(NaN)).toBe(1);
  });
});

describe("sheet geometry", () => {
  it("gives the strip cards the sheet's proportions", () => {
    // Portrait A4 → upright card; landscape → a card wider than it is tall.
    expect(thumbSizePx(withOpts({ paper: "A4" }))).toEqual([59, 84]);
    expect(thumbSizePx(withOpts({ paper: "A4", orientation: "landscape" }))).toEqual([
      119, 84,
    ]);
    expect(thumbSizePx(withOpts({ paper: "Letter" }))).toEqual([65, 84]);
  });

  it("computes the printable box as the sheet minus both margins", () => {
    expect(contentBoxCm(withOpts({ paper: "A4", margin: "normal" }))).toEqual([15.92, 24.62]);
    expect(contentBoxCm(withOpts({ paper: "A4", margin: "none" }))).toEqual([21, 29.7]);
    expect(
      contentBoxCm(withOpts({ paper: "A4", orientation: "landscape", margin: "none" })),
    ).toEqual([29.7, 21]);
  });

  it("fits a quarter-turned page by swapping its box, not by overflowing", () => {
    // transform does not change the layout box, so a turned page is centred out
    // of flow and pre-constrained to the swapped printable box.
    const css = buildOptionsCss(withOpts({ paper: "A4", margin: "none" }), true);
    expect(css).toContain(".print-page.app-rot-90>img,.print-page.app-rot-270>img");
    // Read off the sheet in container units: a box stated in centimetres would
    // overflow the engine's page box exactly as the cm-sized sheet did.
    expect(css).toContain("max-width:100cqh;max-height:100cqw");
    expect(css).toContain("container-type:size");
    expect(css).toContain("rotate(90deg)");
    expect(css).toContain("rotate(270deg)");
    expect(css).toContain(".print-page.app-rot-180>img{transform:rotate(180deg)}");
  });

});

describe("buildOptionsCss", () => {
  it("sets the sheet from paper + orientation, landscape swapping the sides", () => {
    expect(buildOptionsCss(withOpts({ paper: "A4" }))).toContain("@page{size:21cm 29.7cm");
    expect(buildOptionsCss(withOpts({ paper: "A4", orientation: "landscape" }))).toContain(
      "@page{size:29.7cm 21cm",
    );
    expect(buildOptionsCss(withOpts({ paper: "Letter" }))).toContain(
      "@page{size:21.59cm 27.94cm",
    );
  });

  it("applies margins as body padding, never as an @page margin", () => {
    // WebKitGTK ignores the @page margin box — a margin set only there prints
    // edge-to-edge. Same reason the viewer stylesheets pad the body.
    const css = buildOptionsCss(withOpts({ margin: "wide" }));
    expect(css).toContain("padding:3.81cm");
    expect(css).toContain("@page{size:21cm 29.7cm;margin:0}");
    expect(buildOptionsCss(withOpts({ margin: "none" }))).toContain("padding:0cm");
  });

  it("scales content with zoom and divides the on-screen sheet by it", () => {
    // zoom multiplies the sheet box back to true paper size, so the preview
    // shows a real A4 sheet with smaller content — like a printer's scale.
    const css = buildOptionsCss(withOpts({ scale: 50 }));
    expect(css).toContain("zoom:0.5");
    expect(css).toContain("width:42cm");
    expect(css).toContain("min-height:59.4cm");
  });

  it("emits grayscale, background and page-number rules only when enabled", () => {
    const off = buildOptionsCss(DEFAULT_PRINT_OPTIONS);
    expect(off).not.toContain("grayscale(1)");
    expect(off).not.toContain("attr(data-page)");
    // Backgrounds default to on: colors print rather than being stripped.
    expect(off).toContain("print-color-adjust:exact");
    expect(off).not.toContain("background:transparent!important");

    const on = buildOptionsCss(
      withOpts({ grayscale: true, background: false, pageNumbers: true }),
    );
    expect(on).toContain("body{filter:grayscale(1)}");
    // The sheet of a paged document is paper on screen and keeps its white.
    expect(on).toContain("body *:not(.print-page){background:transparent!important");
    expect(on).toContain(".print-page::after{content:attr(data-page)");
  });

  it("always hides deselected pages via the shared class", () => {
    expect(buildOptionsCss(DEFAULT_PRINT_OPTIONS)).toContain(
      ".app-print-hidden{display:none!important}",
    );
  });
});

describe("a document made of sheets", () => {
  // The regression: a PDF page printed inside a text document's 2.54cm margins,
  // at whatever size its raster happened to be — roughly three quarters of the
  // sheet, sitting at the top of it — instead of filling the paper.
  const paged = (patch: Partial<PrintOptions> = {}) =>
    buildOptionsCss({ ...PAGED_PRINT_OPTIONS, ...patch }, true);

  it("gives every sheet the whole page box to fill", () => {
    const css = paged();
    // The page box is the ENGINE's, resolved through a 100% chain from the root:
    // a sheet sized from the paper (29.65cm) overflowed WebKitGTK's 27.84cm page
    // box and printed a blank sheet after every page. The image is capped on
    // BOTH axes so it fits the box.
    expect(css).toContain("html,body{height:100%}");
    expect(css).toContain(".print-page{position:relative;box-sizing:border-box;height:100%;");
    // No centimetre height on the sheet outside the screen-only preview rules.
    const printOnly = css.replace(/@media screen\{.*?\}\}/g, "");
    expect(printOnly).not.toMatch(/\.print-page\{[^}]*height:\d+(\.\d+)?cm/);
    expect(css).not.toContain("100vh");
    expect(css).toContain(".print-page>img{width:auto;height:auto;max-width:100%;max-height:100%}");
    expect(css).toContain("align-items:center");
    // Sized on neither axis: an A1 page fitted onto A4 keeps its aspect.
    expect(css).not.toContain(".print-page>img{width:100%");
  });

  it("scales the image inside the sheet, never the sheet", () => {
    // `zoom` on the body would scale the box the sheet's 100% resolves against;
    // the printer-dialog scale is the image's cap instead, on both axes and in
    // the turned rule too.
    const css = paged({ scale: 50 });
    expect(css).toContain("body{zoom:1}");
    expect(css).toContain("max-width:50%;max-height:50%");
    expect(css).toContain("max-width:50cqh;max-height:50cqw");
  });

  it("shows the sheets as separate pieces of paper on screen", () => {
    // Each sheet is true paper size with a gap and its own shadow; the body is
    // no longer the one white column a flowing document renders as.
    const css = paged();
    expect(css).toContain("@media screen{html{padding-bottom:0}html,body{height:auto}");
    expect(css).toContain("body{width:21cm;min-height:0;background:transparent;box-shadow:none}");
    expect(css).toContain(".print-page{height:29.7cm;margin:0 auto 18px;background:#fff;");
    expect(paged({ orientation: "landscape" })).toContain(".print-page{height:21cm;margin:0 auto 18px");
  });

  it("prints edge to edge by default — the sheet carries its own margins", () => {
    expect(PAGED_PRINT_OPTIONS.margin).toBe("none");
    expect(paged()).toContain("padding:0cm");
  });

  it("puts the margins on the sheet, not on the body", () => {
    // Block-direction padding of a fragmented box applies to its first and last
    // fragment only: body padding would indent sheet 1 and leave the rest flush
    // to the paper edge.
    const css = paged({ margin: "normal" });
    expect(css).toContain("body{margin:0;padding:0cm");
    expect(css).toContain("padding:2.54cm;display:flex");
  });

  it("keeps body padding for a flowing document", () => {
    const css = buildOptionsCss(withOpts({ margin: "normal" }), false);
    expect(css).toContain("body{margin:0;padding:2.54cm");
    expect(css).not.toContain(".print-page>img");
  });

  it("keeps the page number inside the margin band, out of the page", () => {
    const css = paged({ margin: "narrow", pageNumbers: true });
    expect(css).toContain("padding-bottom:calc(1.27cm + 16px)");
    expect(css).toContain("bottom:1.27cm");
  });

  it("fits, never stretches, in the stylesheet the sheets ship with", () => {
    expect(IMAGE_PRINT_CSS).toContain("max-width:100%;max-height:100%");
    expect(IMAGE_PRINT_CSS).not.toContain("100vh");
  });
});

describe("rasterScaleFor", () => {
  it("leaves an ordinary page alone", () => {
    // A4 in big points at 2× is 1191×1684 — nowhere near the canvas limits.
    expect(rasterScaleFor(595, 842, 2)).toBe(2);
  });

  it("shrinks an outsized page to something the canvas can hold", () => {
    // A1 at 2× would be 32 Mpx; past the engine's limit a canvas comes back
    // blank, which prints as a blank sheet.
    const s = rasterScaleFor(1684, 2384, 2);
    expect(s).toBeLessThan(2);
    expect(1684 * s * 2384 * s).toBeLessThanOrEqual(12_000_000 + 1);
    expect(Math.max(1684, 2384) * s).toBeLessThanOrEqual(8192);
  });

  it("survives a page with no measurable size", () => {
    expect(rasterScaleFor(0, 0, 2)).toBe(2);
  });

  it("rasterises an A4 sheet at full print resolution", () => {
    // 300 dpi on paper; a cap that bit here would quietly print soft text again.
    expect(PDF_PRINT_SCALE).toBeCloseTo(300 / 72);
    expect(rasterScaleFor(595, 842, PDF_PRINT_SCALE)).toBe(PDF_PRINT_SCALE);
  });
});

describe("loadPrintOptions", () => {
  it("carries the printer settings over but never the page selection", () => {
    savePrintOptions(
      withOpts({ paper: "Legal", margin: "wide", pages: "custom", range: "2-3" }),
    );
    const loaded = loadPrintOptions();
    expect(loaded.paper).toBe("Legal");
    expect(loaded.margin).toBe("wide");
    // A range typed for one document must not silently drop pages of the next.
    expect(loaded.pages).toBe("all");
    expect(loaded.range).toBe("");
  });

  it("never carries a copy count over to the next document", () => {
    savePrintOptions(withOpts({ copies: 10 }));
    expect(loadPrintOptions().copies).toBe(1);
    expect(sanitizePrintOptions({ copies: 500 }).copies).toBe(99);
  });

  it("remembers sheets and flowing text apart", () => {
    savePrintOptions(withOpts({ margin: "wide" }), "flow");
    // A margin chosen for a memo must not follow the next PDF onto paper.
    expect(loadPrintOptions("page").margin).toBe("none");
    savePrintOptions({ ...PAGED_PRINT_OPTIONS, margin: "narrow" }, "page");
    expect(loadPrintOptions("page").margin).toBe("narrow");
    expect(loadPrintOptions("flow").margin).toBe("wide");
  });

  it("falls back to the kind's own defaults on junk", () => {
    localStorage.setItem(storageKey("print.options.page"), "{not json");
    expect(loadPrintOptions("page").margin).toBe("none");
    localStorage.setItem(storageKey("print.options.page"), JSON.stringify({ margin: "huge" }));
    expect(loadPrintOptions("page").margin).toBe("none");
    expect(sanitizePrintOptions({}, PAGED_PRINT_OPTIONS).margin).toBe("none");
  });
});

describe("sanitizePrintOptions", () => {
  it("falls back to the defaults for missing or bogus stored values", () => {
    expect(sanitizePrintOptions(null)).toEqual(DEFAULT_PRINT_OPTIONS);
    expect(sanitizePrintOptions({ paper: "B7", pages: "some", scale: "x" })).toEqual(
      DEFAULT_PRINT_OPTIONS,
    );
  });

  it("keeps valid values and clamps the scale", () => {
    const o = sanitizePrintOptions({ paper: "Legal", scale: 5000, grayscale: true });
    expect(o.paper).toBe("Legal");
    expect(o.scale).toBe(400);
    expect(o.grayscale).toBe(true);
  });
});
