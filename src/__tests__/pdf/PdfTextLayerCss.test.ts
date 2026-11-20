/**
 * Regression lock for "the PDF viewer shows text but none of it can be selected"
 * (#pdf-textselect).
 *
 * The text layer's rules are a hand copy of pdf.js's `.textLayer` sheet, and two
 * parts of that copy are load-bearing without looking it:
 *
 * - The spans must opt back into `user-select: text`. The app root sets
 *   `user-select: none` (base.css) and every span inherits it, so without the opt-in
 *   the layer is present, correctly placed, and selects nothing — and copy-on-select
 *   never has anything to copy.
 * - The spans must be sized from `--total-scale-factor` × `--font-height`, the
 *   properties pdf.js 5+ writes. Without them each run takes the inherited font
 *   size, and its box no longer covers the glyphs the reader drags across.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";
import { readAppStylesheet } from "../helpers/cssCorpus";

const CSS: string = readAppStylesheet().replace(/\/\*[\s\S]*?\*\//g, "");

/** Every declaration block whose selector list mentions `needle`, joined. */
function bodiesFor(needle: string): string {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(CSS))) {
    if (m[1].includes(needle)) out.push(m[2]);
  }
  return out.join("\n");
}

describe("PDF text layer CSS", () => {
  it("opts the text spans back into selection", () => {
    const body = bodiesFor(".file-viewer-pdf-text-layer :is(span, br)");
    expect(body).toMatch(/(^|[^-])user-select:\s*text/);
    expect(body).toMatch(/-webkit-user-select:\s*text/);
  });

  it("sizes each run from pdf.js's own scale properties", () => {
    const body = bodiesFor(".file-viewer-pdf-text-layer > :not(.markedContent)");
    expect(body).toMatch(/font-size:\s*calc\(var\(--text-scale-factor\)\s*\*\s*var\(--font-height\)\)/);
    expect(body).toMatch(/scaleX\(var\(--scale-x\)\)/);
    expect(bodiesFor(".file-viewer-pdf-text-layer")).toMatch(
      /--text-scale-factor:\s*calc\(var\(--total-scale-factor\)/,
    );
  });

  it("has the endOfContent block that catches a drag over a gap", () => {
    const rest = bodiesFor(".file-viewer-pdf-text-layer .endOfContent");
    expect(rest).toMatch(/position:\s*absolute/);
    expect(rest).toMatch(/(^|[^-])user-select:\s*none/);
    expect(bodiesFor(".file-viewer-pdf-text-layer.selecting .endOfContent")).toMatch(/top:\s*0/);
    expect(bodiesFor(".file-viewer-pdf-text-layer .markedContent")).toMatch(/display:\s*contents/);
  });

  it("hands the layer the zoom under the name pdf.js reads", () => {
    const src: string = readFileSync("src/components/embed/pdf/PdfTextLayer.tsx", "utf8");
    expect(src).toContain('"--total-scale-factor": scale');
  });
});
