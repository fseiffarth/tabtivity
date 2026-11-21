/**
 * Regression lock for "selecting text in a (LaTeX) PDF jumps all over the page"
 * (#pdf-textselect): the pdf.js viewer behaviour ported in `textSelection.ts`.
 *
 * A drag over the gap between two spans has no text under it; without the
 * `endOfContent` block, and on WebKit without moving that block after the span the
 * selection's end is in, the engine snaps the selection to the page's end.
 */
import { afterEach, describe, expect, it } from "vitest";
import { selectedTextRects } from "../../components/embed/pdf/selection";
import {
  attachTextSelection,
  END_OF_CONTENT_CLASS,
  normalizeCopiedText,
  SELECTING_CLASS,
  TEXT_LAYER_CLASS,
} from "../../components/embed/pdf/textSelection";

const detachers: (() => void)[] = [];
afterEach(() => {
  detachers.splice(0).forEach((d) => d());
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

function makeLayer(words: string[]) {
  const layer = document.createElement("div");
  layer.className = TEXT_LAYER_CLASS;
  for (const w of words) {
    const span = document.createElement("span");
    span.textContent = w;
    layer.append(span);
  }
  document.body.append(layer);
  detachers.push(attachTextSelection(layer));
  return layer;
}

const endOf = (layer: HTMLElement) =>
  layer.querySelector<HTMLElement>(`.${END_OF_CONTENT_CLASS}`);

describe("PDF text selection (pdf.js viewer port)", () => {
  it("adds one endOfContent block after the spans", () => {
    const layer = makeLayer(["One", "two"]);
    expect(layer.querySelectorAll(`.${END_OF_CONTENT_CLASS}`)).toHaveLength(1);
    expect(layer.lastElementChild).toBe(endOf(layer));
  });

  it("marks the layer selecting on mousedown and puts it back on pointerup", () => {
    const layer = makeLayer(["One"]);
    layer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(layer.classList.contains(SELECTING_CLASS)).toBe(true);
    document.dispatchEvent(new Event("pointerup"));
    expect(layer.classList.contains(SELECTING_CLASS)).toBe(false);
  });

  it("moves the block right after the span the selection ends in", () => {
    const layer = makeLayer(["Alpha ", "beta ", "gamma"]);
    const spans = layer.querySelectorAll("span");
    const range = document.createRange();
    range.setStart(spans[0].firstChild!, 0);
    range.setEnd(spans[1].firstChild!, 2);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    expect(layer.classList.contains(SELECTING_CLASS)).toBe(true);
    expect(spans[1].nextSibling).toBe(endOf(layer));
    // The drag let go: the block goes home, after every span.
    document.dispatchEvent(new Event("pointerup"));
    expect(layer.lastElementChild).toBe(endOf(layer));
  });

  it("leaves a layer the selection does not touch at rest", () => {
    const a = makeLayer(["Here"]);
    const b = makeLayer(["There"]);
    const range = document.createRange();
    range.selectNodeContents(a.querySelector("span")!);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    expect(a.classList.contains(SELECTING_CLASS)).toBe(true);
    expect(b.classList.contains(SELECTING_CLASS)).toBe(false);
    expect(b.lastElementChild).toBe(endOf(b));
  });

  it("detaching removes the block and stops reacting", () => {
    const layer = makeLayer(["One"]);
    detachers.pop()!();
    expect(endOf(layer)).toBeNull();
    layer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(layer.classList.contains(SELECTING_CLASS)).toBe(false);
  });

  it("folds ligatures and drops null characters on copy", () => {
    expect(normalizeCopiedText("ﬁnd the ﬀ e\u0000ect")).toBe("find the ff eect");
    expect(normalizeCopiedText("a b")).toBe("a b");
    expect(normalizeCopiedText("plain text")).toBe("plain text");
  });

  it("measures only the selected text, never the page-covering block", () => {
    const layer = makeLayer(["Alpha ", "beta ", "gamma"]);
    layer.classList.add(SELECTING_CLASS);
    const spans = layer.querySelectorAll("span");
    // Each measured range reports one box as wide as the text it holds; the
    // endOfContent block, were it measured, would be a 1000px page.
    // jsdom has no Range layout, so the measurement is defined for the test.
    const proto = Range.prototype as { getClientRects?: () => DOMRectList };
    const had = Object.getOwnPropertyDescriptor(proto, "getClientRects");
    proto.getClientRects = function (this: Range) {
      const w = this.toString().length;
      return [new DOMRect(0, 0, w, 10)] as unknown as DOMRectList;
    };
    try {
      const range = document.createRange();
      range.setStart(spans[0].firstChild!, 2); // "pha "
      range.setEnd(spans[2].firstChild!, 3); // "gam"
      const widths = selectedTextRects(document.body, range).map((r) => r.width);
      expect(widths).toEqual([4, 5, 3]);
    } finally {
      if (had) Object.defineProperty(proto, "getClientRects", had);
      else delete proto.getClientRects;
    }
  });

  it("over a gap, snaps the moving end to the line level with the pointer", async () => {
    // Two lines whose boxes overlap in y 10–12 (as pdf.js's ascent-plus-descent spans
    // can): a pointer in that band is inside both, and belongs to the nearer middle.
    const layer = makeLayer(["first ", "line", "second line"]);
    const [a1, a2, b1] = Array.from(layer.querySelectorAll("span"));
    const box = (l: number, t: number, w: number, h: number) => () => new DOMRect(l, t, w, h);
    a1.getBoundingClientRect = box(0, 0, 50, 12);
    a2.getBoundingClientRect = box(50, 0, 40, 12);
    b1.getBoundingClientRect = box(0, 10, 60, 12);
    const doc = document as Document & { elementFromPoint?: (x: number, y: number) => Element | null };
    const had = doc.elementFromPoint;
    doc.elementFromPoint = () => endOf(layer);
    try {
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.collapse(a1.firstChild!, 0);
      document.dispatchEvent(new MouseEvent("pointerdown", { clientX: 1, clientY: 1 }));
      layer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      // In the right margin, level with the second line.
      document.dispatchEvent(new MouseEvent("pointermove", { clientX: 200, clientY: 11.8 }));
      await new Promise((r) => setTimeout(r, 5));
      expect(sel.focusNode).toBe(b1.firstChild);
      expect(sel.focusOffset).toBe("second line".length);
      // Level with the first line: its last run, not the overlapping second line.
      document.dispatchEvent(new MouseEvent("pointermove", { clientX: 200, clientY: 10.2 }));
      await new Promise((r) => setTimeout(r, 5));
      expect(sel.focusNode).toBe(a2.firstChild);
      expect(sel.focusOffset).toBe("line".length);
    } finally {
      doc.elementFromPoint = had;
      document.dispatchEvent(new MouseEvent("pointerup"));
    }
  });

  it("snaps at release too, but never turns a click in a gap into a selection", async () => {
    const layer = makeLayer(["only line"]);
    const [span] = Array.from(layer.querySelectorAll("span"));
    span.getBoundingClientRect = () => new DOMRect(0, 0, 50, 10);
    const doc = document as Document & { elementFromPoint?: (x: number, y: number) => Element | null };
    const had = doc.elementFromPoint;
    doc.elementFromPoint = () => endOf(layer);
    try {
      const sel = document.getSelection()!;
      // A click with a pixel of jitter, in the margin: the caret stays put.
      sel.collapse(span.firstChild!, 0);
      document.dispatchEvent(new MouseEvent("pointerdown", { clientX: 100, clientY: 5 }));
      document.dispatchEvent(new MouseEvent("pointermove", { clientX: 101, clientY: 5 }));
      document.dispatchEvent(new MouseEvent("pointerup", { clientX: 101, clientY: 5 }));
      await new Promise((r) => setTimeout(r, 5));
      expect(sel.isCollapsed).toBe(true);
      // A drag released in the margin before any move's timeout ran: snapped at once.
      sel.collapse(span.firstChild!, 0);
      document.dispatchEvent(new MouseEvent("pointerdown", { clientX: 2, clientY: 5 }));
      document.dispatchEvent(new MouseEvent("pointermove", { clientX: 120, clientY: 5 }));
      document.dispatchEvent(new MouseEvent("pointerup", { clientX: 120, clientY: 5 }));
      expect(sel.focusNode).toBe(span.firstChild);
      expect(sel.focusOffset).toBe("only line".length);
    } finally {
      doc.elementFromPoint = had;
    }
  });
});
