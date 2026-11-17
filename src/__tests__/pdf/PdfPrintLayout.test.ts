/**
 * `layoutPrintPdf` — the print preview's sheets rebuilt as a real PDF. Pinned:
 * the output is the preview's job (order, selection, copies, paper), and a
 * turned page lands inside its box, not off the paper.
 */
import { describe, it, expect } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, decodePDFRawStream, degrees, type PDFRawStream } from "pdf-lib";
import { layoutPrintPdf, turnedOrigin } from "../../lib/viewers/pdfPrintLayout";
import { PAGED_PRINT_OPTIONS, type PrintOptions } from "../../lib/viewers/print";

const A4_PT: [number, number] = [595.28, 841.89];

/** A source whose pages are told apart by width: page n is 100·n pt wide. */
async function source(rotateFirst = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let n = 1; n <= 3; n++) {
    const page = doc.addPage([100 * n, 400]);
    page.drawRectangle({ x: 10, y: 10, width: 20, height: 20 });
    if (n === 1 && rotateFirst) page.setRotation(degrees(rotateFirst));
  }
  return doc.save();
}

const opts = (over: Partial<PrintOptions> = {}): PrintOptions => ({ ...PAGED_PRINT_OPTIONS, ...over });

describe("layoutPrintPdf", () => {
  it("prints the preview's sheets, in its order, on its paper", async () => {
    const out = await PDFDocument.load(
      await layoutPrintPdf(await source(), [{ page: 3, rot: 0 }, { page: 1, rot: 0 }], opts()),
    );
    expect(out.getPageCount()).toBe(2);
    for (const page of out.getPages()) {
      const { width, height } = page.getSize();
      expect(width).toBeCloseTo(A4_PT[0], 0);
      expect(height).toBeCloseTo(A4_PT[1], 0);
    }
  });

  it("repeats the whole job per copy, collated", async () => {
    const out = await PDFDocument.load(
      await layoutPrintPdf(await source(), [{ page: 2, rot: 0 }, { page: 1, rot: 0 }], opts({ copies: 3 })),
    );
    expect(out.getPageCount()).toBe(6);
  });

  it("lays landscape paper out landscape", async () => {
    const out = await PDFDocument.load(
      await layoutPrintPdf(await source(), [{ page: 1, rot: 0 }], opts({ orientation: "landscape" })),
    );
    const { width, height } = out.getPage(0).getSize();
    expect(width).toBeGreaterThan(height);
  });

  // 2442aa: where the system dialog cannot be preset to grayscale (Windows,
  // macOS), the PDF itself is made gray — a Saturation blend over each sheet,
  // in an RGB transparency group — and only when the job asks for grayscale.
  it("bakes grayscale into every sheet only when asked to", async () => {
    const sheets = [{ page: 1, rot: 0 }, { page: 2, rot: 0 }];
    /** Per output page: its transparency group, and the blend modes of its graphics states. */
    const inspect = async (bytes: Uint8Array) => {
      const doc = await PDFDocument.load(bytes);
      return doc.getPages().map((page) => {
        const states = page.node.Resources()?.lookupMaybe(PDFName.of("ExtGState"), PDFDict);
        const modes = (states?.values() ?? []).map((v) =>
          String(doc.context.lookupMaybe(v, PDFDict)?.get(PDFName.of("BM")) ?? ""),
        );
        return { group: String(page.node.get(PDFName.of("Group")) ?? ""), modes };
      });
    };
    const baked = await inspect(
      await layoutPrintPdf(await source(), sheets, opts({ grayscale: true }), { bakeGrayscale: true }),
    );
    expect(baked).toHaveLength(2);
    for (const page of baked) {
      expect(page.modes).toContain("/Saturation");
      expect(page.group).toContain("/Transparency");
    }
    // Colour asked for, or a dialog that takes the preset (Linux): untouched.
    const untouched = [
      await layoutPrintPdf(await source(), sheets, opts({ grayscale: false }), { bakeGrayscale: true }),
      await layoutPrintPdf(await source(), sheets, opts({ grayscale: true })),
    ];
    for (const bytes of untouched) {
      for (const page of await inspect(bytes)) {
        expect(page.modes).not.toContain("/Saturation");
        expect(page.group).toBe("");
      }
    }
  });

  // A page is an isolated transparency group: paper the document paints
  // nothing on has no backdrop, and the Saturation rectangle over none paints
  // its own 50 % gray there — the whole sheet came out gray around the text
  // (Ghostscript, MuPDF and Poppler all render it so). The sheet is painted
  // white first, beneath the document, so the blend always has a backdrop.
  it("paints a baked-grayscale sheet white beneath the document", async () => {
    /** The page's content streams, decoded, as one string of operators. */
    const operators = (doc: PDFDocument, index: number): string => {
      const contents = doc.getPage(index).node.Contents();
      const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => doc.context.lookup(ref)) : [contents];
      return streams
        .map((s) => new TextDecoder("latin1").decode(decodePDFRawStream(s as PDFRawStream).decode()))
        .join("\n");
    };
    const sheets = [{ page: 1, rot: 0 }, { page: 2, rot: 0 }];
    const baked = await PDFDocument.load(
      await layoutPrintPdf(await source(), sheets, opts({ grayscale: true }), { bakeGrayscale: true }),
    );
    for (let i = 0; i < baked.getPageCount(); i++) {
      const ops = operators(baked, i);
      const white = ops.indexOf("1 1 1 rg");
      const firstDraw = ops.indexOf(" Do");
      const blend = ops.lastIndexOf(" gs");
      expect(white).toBeGreaterThanOrEqual(0);
      expect(firstDraw).toBeGreaterThan(white);
      // The white fill covers the whole sheet and is closed before the document is drawn.
      expect(ops.slice(white, firstDraw)).toMatch(/0 0 595\.\d+ 841\.\d+ re\s+f\s+Q/);
      // The gray blend stays the last thing on the sheet.
      expect(blend).toBeGreaterThan(ops.lastIndexOf(" Do"));
    }
    // Colour, or a dialog that takes the preset: no backdrop is added.
    for (const bytes of [
      await layoutPrintPdf(await source(), sheets, opts({ grayscale: false }), { bakeGrayscale: true }),
      await layoutPrintPdf(await source(), sheets, opts({ grayscale: true })),
    ]) {
      const doc = await PDFDocument.load(bytes);
      for (let i = 0; i < doc.getPageCount(); i++) expect(operators(doc, i)).not.toContain("1 1 1 rg");
    }
  });

  it("refuses an empty job rather than printing a blank one", async () => {
    await expect(layoutPrintPdf(await source(), [], opts())).rejects.toThrow();
  });

  it("keeps the page vector: a form XObject, not an image", async () => {
    const bytes = await layoutPrintPdf(await source(90), [{ page: 1, rot: 90 }], opts({ pageNumbers: true }));
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).toContain("/Subtype /Form");
    expect(text).not.toContain("/Subtype /Image");
  });
});

describe("turnedOrigin", () => {
  // Rotate the page's corners the way pdf-lib does (counter-clockwise by
  // −turn about the origin) and check they fill exactly the target box.
  const corners = (turn: number, bx: number, by: number, w: number, h: number) => {
    const { x, y } = turnedOrigin(turn, bx, by, w, h);
    const a = (-turn * Math.PI) / 180;
    const pts = [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ].map(([u, v]) => [x + u * Math.cos(a) - v * Math.sin(a), y + u * Math.sin(a) + v * Math.cos(a)]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };

  it.each([0, 90, 180, 270])("a %i° turn lands on the box", (turn) => {
    const [w, h] = [30, 50];
    const [bw, bh] = turn % 180 ? [h, w] : [w, h];
    const box = corners(turn, 7, 11, w, h);
    [7, 11, 7 + bw, 11 + bh].forEach((v, i) => expect(box[i]).toBeCloseTo(v, 6));
  });
});
