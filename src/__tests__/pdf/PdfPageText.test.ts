/**
 * `pageTextItemBoxes` reads a page's text once per document, page and turn:
 * the markup tools, the question pins and the search share the read.
 */
import { describe, expect, it, vi } from "vitest";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { markupPagePicture } from "../../components/embed/pdf/markupPage";
import { pageTextItemBoxes } from "../../components/embed/pdf/pageText";

vi.mock("../../../mobile-web/src/markup/rasterize", async (original) => ({
  ...(await original<typeof import("../../../mobile-web/src/markup/rasterize")>()),
  layerPng: vi.fn(async () => new Blob(["layer"], { type: "image/png" })),
}));

/** A one-word page: the document counts how often a page's text is asked. */
function fakeDoc(failFirst = false) {
  let asked = 0;
  const getTextContent = vi.fn(async () => {
    asked++;
    if (failFirst && asked === 1) throw new Error("text");
    return { items: [{ str: "word", transform: [10, 0, 0, 10, 20, 30], width: 40, hasEOL: false }] };
  });
  const getPage = vi.fn(async () => ({
    rotate: 0,
    getViewport: ({ rotation }: { rotation: number }) => ({ transform: [1, 0, 0, -1, 0, 800], rotation }),
    getTextContent,
  }));
  return { doc: { getPage } as unknown as PDFDocumentProxy, getPage, getTextContent };
}

describe("pageTextItemBoxes", () => {
  it("reads a page once per document, page and turn", async () => {
    const { doc, getTextContent } = fakeDoc();
    const first = await pageTextItemBoxes(doc, 1);
    expect(first).toHaveLength(1);
    expect(await pageTextItemBoxes(doc, 1)).toBe(first);
    expect(await pageTextItemBoxes(doc, 1, 0)).toBe(first);
    expect(getTextContent).toHaveBeenCalledTimes(1);
    // Another page and another turn are other reads.
    await pageTextItemBoxes(doc, 2);
    await pageTextItemBoxes(doc, 1, 90);
    expect(getTextContent).toHaveBeenCalledTimes(3);
  });

  it("shares a read still in flight", async () => {
    const { doc, getTextContent } = fakeDoc();
    const [a, b] = await Promise.all([pageTextItemBoxes(doc, 1), pageTextItemBoxes(doc, 1)]);
    expect(a).toBe(b);
    expect(getTextContent).toHaveBeenCalledTimes(1);
  });

  it("keeps a document's reads apart from another's", async () => {
    const one = fakeDoc();
    const two = fakeDoc();
    await pageTextItemBoxes(one.doc, 1);
    await pageTextItemBoxes(two.doc, 1);
    expect(one.getTextContent).toHaveBeenCalledTimes(1);
    expect(two.getTextContent).toHaveBeenCalledTimes(1);
  });

  it("asks again after a failed read", async () => {
    const { doc, getTextContent } = fakeDoc(true);
    await expect(pageTextItemBoxes(doc, 1)).rejects.toThrow("text");
    await Promise.resolve();
    expect(await pageTextItemBoxes(doc, 1)).toHaveLength(1);
    expect(getTextContent).toHaveBeenCalledTimes(2);
  });
});

describe("markupPagePicture", () => {
  it("starts the page's text read before drawing, and a read nobody awaits raises no unhandled rejection", async () => {
    // A document whose pages cannot be had: the draw throws before the words
    // are awaited, and the read fails alike.
    const getPage = vi.fn(async () => { throw new Error("page"); });
    const doc = { getPage } as unknown as PDFDocumentProxy;
    const picture = await markupPagePicture(doc, 1, { size: [600, 800], marks: [] });
    expect(picture.composed).toBe(false);
    // Two page reads: one for the drawing, one for the words.
    expect(getPage).toHaveBeenCalledTimes(2);
    // Vitest fails the run on a rejection nobody handled: let one surface.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
