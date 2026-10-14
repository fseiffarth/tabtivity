/**
 * `scrollIntoPdfBox` — the scoped replacement for `Element.scrollIntoView` in the
 * PDF reader (#56 forward search, Ctrl+F, page/outline jumps, remark focus).
 *
 * The bug it exists for: `scrollIntoView` scrolls EVERY scrollable ancestor, and
 * an `overflow: hidden` box is one — so a SyncTeX jump displaced the whole pane
 * (`.file-viewer`), which has no scrollbar to put it back. These tests pin the
 * two properties that matters: ancestors never move, and the horizontal axis is
 * left alone while the page fits the pane (the fit-to-width centring).
 *
 * jsdom has no layout, so the box and the target are given explicit metrics.
 */
import { describe, it, expect } from "vitest";
import { scrollIntoPdfBox } from "../../components/embed/pdf/scrollBox";

interface BoxMetrics {
  /** Border-box rect of the scroller, as `getBoundingClientRect` reports it. */
  top: number;
  left: number;
  clientHeight: number;
  clientWidth: number;
}

/** A `.file-viewer` (overflow: hidden, no scrollbar) wrapping a PDF scroller
 *  wrapping one target element — the chain the reader actually has. */
function makeChain(box: BoxMetrics, target: { top: number; left: number; w: number; h: number }) {
  const pane = document.createElement("div");
  pane.className = "file-viewer";
  const scroll = document.createElement("div");
  scroll.className = "file-viewer-pdf-scroll";
  const el = document.createElement("div");
  scroll.appendChild(el);
  pane.appendChild(scroll);
  document.body.appendChild(pane);

  // Scroll offsets jsdom does not model: real, settable, readable back.
  for (const node of [pane, scroll]) {
    let top = 0;
    let left = 0;
    Object.defineProperty(node, "scrollTop", {
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
    Object.defineProperty(node, "scrollLeft", {
      get: () => left,
      set: (v: number) => {
        left = v;
      },
    });
  }
  const metric = (node: HTMLElement, name: string, value: number) =>
    Object.defineProperty(node, name, { get: () => value });
  metric(scroll, "clientHeight", box.clientHeight);
  metric(scroll, "clientWidth", box.clientWidth);
  metric(scroll, "clientTop", 0);
  metric(scroll, "clientLeft", 0);
  metric(pane, "clientHeight", box.clientHeight);
  metric(pane, "clientWidth", box.clientWidth);
  scroll.getBoundingClientRect = () =>
    ({ top: box.top, left: box.left, height: box.clientHeight, width: box.clientWidth }) as DOMRect;
  el.getBoundingClientRect = () =>
    ({ top: target.top, left: target.left, height: target.h, width: target.w }) as DOMRect;
  return { pane, scroll, el };
}

/** A 400x500 scroller at (50,100) with 12px padding, holding a fit-to-width page. */
const BOX: BoxMetrics = { top: 100, left: 50, clientHeight: 500, clientWidth: 400 };

describe("scrollIntoPdfBox", () => {
  it("centres the target vertically in the scroller and leaves ancestors alone", () => {
    // 800px below the scrollport's top, 20px tall: centred at 800 - (500-20)/2.
    const { pane, scroll, el } = makeChain(BOX, { top: 900, left: 62, w: 376, h: 20 });
    expect(scrollIntoPdfBox(el, "center")).toBe(true);
    expect(scroll.scrollTop).toBe(560);
    expect(pane.scrollTop).toBe(0);
    expect(pane.scrollLeft).toBe(0);
  });

  it("puts the target's top at the scrollport's top for block: start", () => {
    const { scroll, el } = makeChain(BOX, { top: 900, left: 62, w: 376, h: 20 });
    scrollIntoPdfBox(el, "start");
    expect(scroll.scrollTop).toBe(800);
  });

  it("never moves the horizontal axis while the page fits the pane", () => {
    // The fit-to-width page spans the scroller's content box exactly; the SyncTeX
    // box sits inside it. A horizontal scroll here is what knocked the centred
    // page sideways and left it there.
    const { scroll, el } = makeChain(BOX, { top: 300, left: 120, w: 90, h: 14 });
    scrollIntoPdfBox(el, "center");
    expect(scroll.scrollLeft).toBe(0);
  });

  it("nudges horizontally only far enough to show a target off the right edge", () => {
    // Zoomed in past the fit: the target word sits 60px beyond the right edge.
    const { scroll, el } = makeChain(BOX, { top: 300, left: 50 + 380, w: 80, h: 14 });
    scrollIntoPdfBox(el, "center");
    // left 380, right 460, scrollport 400 wide → the least scroll showing it.
    expect(scroll.scrollLeft).toBe(60);
  });

  it("does nothing at all when the pane is not laid out (hidden behind a tab)", () => {
    const { pane, scroll, el } = makeChain(
      { top: 0, left: 0, clientHeight: 0, clientWidth: 0 },
      { top: 0, left: 0, w: 0, h: 0 },
    );
    scroll.scrollTop = 420;
    // …and says so, so the SyncTeX reveal can try again when the pane is shown.
    expect(scrollIntoPdfBox(el, "center")).toBe(false);
    expect(scroll.scrollTop).toBe(420);
    expect(pane.scrollTop).toBe(0);
  });

  it("is a no-op for an element outside any PDF scroller", () => {
    const loose = document.createElement("div");
    document.body.appendChild(loose);
    expect(scrollIntoPdfBox(loose, "center")).toBe(false);
  });
});
