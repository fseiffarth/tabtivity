/**
 * Ctrl+wheel zoom in the PDF viewer (`PdfViewer.tsx`, performance plan §4.1):
 * the ticks of one gesture are previewed with a CSS transform and rasterised
 * ONCE, after the gesture pauses (`PDF_ZOOM_COMMIT_MS`) — not once per tick,
 * which allocated a canvas up to `PDF_MAX_CANVAS_PIXELS` per near page per
 * notch and cancelled the previous render each time. The zoom is persisted
 * once too, at the commit. The +/− buttons still zoom at once.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  renders: 0,
  invoke: vi.fn(),
}));

/** A two-page pdf.js document: 600 × 800 points, nothing drawn, no text. Every
 *  `page.render` is counted. */
vi.mock("pdfjs-dist", () => {
  const viewport = ({ scale = 1, rotation = 0 }: { scale?: number; rotation?: number } = {}) => {
    const turned = rotation % 180 !== 0;
    const width = (turned ? 800 : 600) * scale;
    const height = (turned ? 600 : 800) * scale;
    return {
      width,
      height,
      scale,
      rotation,
      transform: [scale, 0, 0, -scale, 0, height],
      viewBox: [0, 0, 600, 800],
      clone: () => viewport({ scale, rotation }),
      convertToViewportPoint: (x: number, y: number) => [x * scale, height - y * scale],
      convertToPdfPoint: (x: number, y: number) => [x / scale, (height - y) / scale],
    };
  };
  const page = () => ({
    rotate: 0,
    view: [0, 0, 600, 800],
    getViewport: viewport,
    render: () => {
      io.renders += 1;
      return { promise: Promise.resolve(), cancel() {} };
    },
    getTextContent: async () => ({ items: [], styles: {} }),
    getAnnotations: async () => [],
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    cleanup() {},
  });
  const doc = () => ({
    numPages: 2,
    getPage: async () => page(),
    getOutline: async () => null,
    getMetadata: async () => ({ info: {}, metadata: null }),
    getDestination: async () => null,
    getPageIndex: async () => 0,
    getDownloadInfo: async () => ({ length: 4 }),
    getPageLabels: async () => null,
    annotationStorage: { setValue() {}, getValue: () => undefined, has: () => false },
    loadingTask: { destroy: async () => {} },
    destroy: async () => {},
  });
  return {
    GlobalWorkerOptions: { workerSrc: "" },
    AnnotationMode: { DISABLE: 0, ENABLE: 1, ENABLE_FORMS: 2, ENABLE_STORAGE: 3 },
    Util: {
      transform: (a: number[], b: number[]) => [
        a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
      ],
    },
    PDFWorker: class {
      destroyed = false;
      destroy() {}
    },
    TextLayer: class {
      render() { return Promise.resolve(); }
      cancel() {}
    },
    getDocument: () => ({ promise: Promise.resolve(doc()), destroy: async () => {} }),
  };
});
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: io.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { PdfView, PDF_ZOOM_COMMIT_MS } from "../../components/embed/pdf/PdfViewer";
import { FileScopeContext } from "../../lib/files/fileAccess";
import { useTabsStore, type TabEntry, type ViewerState } from "../../stores/tabs";

const PATH = "/home/u/paper/paper.pdf";
const TAB = "pdf-tab";

const scroller = () => document.querySelector(".file-viewer-pdf-scroll") as HTMLElement;
const stack = () => document.querySelector(".file-viewer-pdf-pages") as HTMLElement;
const wraps = () => [...document.querySelectorAll<HTMLElement>(".file-viewer-pdf-page-wrap")];

/** The resize observers the viewer created on its page stack, so a test can
 *  report "the stack has relaid out" after a zoom commit (jsdom has none). */
const resizeObservers: ResizeObserverCallback[] = [];
class ResizeObserverStub {
  constructor(cb: ResizeObserverCallback) { resizeObservers.push(cb); }
  observe() {}
  unobserve() {}
  disconnect() {}
}
const relaidOut = () =>
  resizeObservers.forEach((cb) => cb([], undefined as unknown as ResizeObserver));

/** The scroller's geometry as a browser would lay it out: a 700 × 500 viewport,
 *  the stack behind its 12 px padding, the wraps stacked top to bottom, each
 *  its canvas's CSS box plus the 28 px page-number gap that does NOT scale. */
const VIEW_W = 700;
const VIEW_H = 500;
const PAD = 12;
const GAP = 28;
const rect = (x: number, y: number, w: number, h: number) =>
  ({ x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h, toJSON() {} }) as DOMRect;
function canvasBox(wrap: HTMLElement) {
  const c = wrap.querySelector("canvas") as HTMLCanvasElement;
  return { w: parseFloat(c.style.width) || 0, h: parseFloat(c.style.height) || 0 };
}
function layOut() {
  const el = scroller();
  const boxes = new Map<Element, DOMRect>();
  boxes.set(el, rect(0, 0, VIEW_W, VIEW_H));
  const x = PAD - el.scrollLeft;
  let y = PAD - el.scrollTop;
  const top = y;
  let width = 0;
  for (const wrap of wraps()) {
    const { w, h } = canvasBox(wrap);
    boxes.set(wrap, rect(x, y, w, h + GAP));
    y += h + GAP;
    width = Math.max(width, w);
  }
  boxes.set(stack(), rect(x, top, width, y - top));
  return boxes;
}
function mockLayout() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return layOut().get(this) ?? rect(0, 0, 0, 0);
  });
}
const zoomLabel = () => document.querySelector(".file-viewer-zoom-level")!.textContent;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One Ctrl+wheel notch toward the cursor at (20, 30), zooming in. */
function tick(deltaY = -100) {
  scroller().dispatchEvent(
    new WheelEvent("wheel", { deltaY, ctrlKey: true, clientX: 20, clientY: 30, bubbles: true, cancelable: true }),
  );
}

/** Every write of a scale into the tab's viewer state. */
let scaleWrites: number[] = [];
/** The store's own setter, wrapped per test and put back after it. */
const setViewerState = useTabsStore.getState().setViewerState;

/** Mount the viewer on its tab and wait until both pages have painted once. */
async function mounted() {
  const view = render(
    <FileScopeContext.Provider value="p1">
      <PdfView path={PATH} tabKey={TAB} onOpenExternally={() => {}} />
    </FileScopeContext.Provider>,
  );
  await waitFor(() => expect(io.renders).toBe(2));
  // Let the first paint's fingerprint and persist land before counting.
  await sleep(50);
  expect(io.renders).toBe(2);
  scaleWrites = [];
  return view;
}

beforeEach(() => {
  io.renders = 0;
  resizeObservers.length = 0;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
  io.invoke.mockReset();
  io.invoke.mockImplementation(async (command: string) => {
    if (command === "read_file_bytes") return [37, 80, 68, 70];
    if (command === "file_mtime") return 1_000;
    return null;
  });
  useTabsStore.setState({
    tabsByScope: {
      p1: [{ key: TAB, label: "paper.pdf", cmd: "", cwd: "/home/u/paper", kind: "embed", embedPath: PATH, viewer: "pdf" } as TabEntry],
    },
  });
  useTabsStore.setState({
    setViewerState: (key: string, patch: ViewerState) => {
      if (key === TAB && patch.scale != null) scaleWrites.push(patch.scale);
      setViewerState(key, patch);
    },
  });
  // A 2D context, so the render path runs (jsdom has none by default): the
  // off-screen canvas is painted by `page.render` and blitted onto the page's.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage() {},
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  cleanup();
  delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;
  useTabsStore.setState({ setViewerState });
  vi.restoreAllMocks();
});

describe("Ctrl+wheel zoom", () => {
  it("previews a burst of ticks with CSS and rasterises once when the gesture pauses", async () => {
    const { container } = await mounted();
    act(() => {
      for (let i = 0; i < 5; i++) tick();
    });
    // The label and the stack follow the gesture at once …
    expect(zoomLabel()).toBe(`${Math.round(1.2 * 1.2 ** 5 * 100)}%`);
    const stack = container.querySelector(".file-viewer-pdf-pages") as HTMLElement;
    expect(Number(/scale\(([\d.]+)\)/.exec(stack.style.transform)?.[1])).toBeCloseTo(1.2 ** 5, 6);
    // … and nothing has been rendered or persisted for it yet.
    expect(io.renders).toBe(2);
    expect(scaleWrites).toEqual([]);
    // After the pause: one render per page, one persist, the transform gone.
    await waitFor(() => expect(io.renders).toBe(4), { timeout: PDF_ZOOM_COMMIT_MS * 10 });
    await sleep(PDF_ZOOM_COMMIT_MS);
    expect(io.renders).toBe(4);
    expect(stack.style.transform).toBe("");
    expect(scaleWrites).toHaveLength(1);
    expect(scaleWrites[0]).toBeCloseTo(1.2 * 1.2 ** 5, 6);
    expect(zoomLabel()).toBe(`${Math.round(1.2 * 1.2 ** 5 * 100)}%`);
  });

  it("re-arms the commit on every tick, so a slow gesture still renders once", async () => {
    await mounted();
    for (let i = 0; i < 3; i++) {
      act(() => tick());
      await sleep(PDF_ZOOM_COMMIT_MS / 2);
    }
    expect(io.renders).toBe(2);
    await waitFor(() => expect(io.renders).toBe(4), { timeout: PDF_ZOOM_COMMIT_MS * 10 });
    await sleep(PDF_ZOOM_COMMIT_MS);
    expect(io.renders).toBe(4);
    expect(scaleWrites).toHaveLength(1);
    expect(scaleWrites[0]).toBeCloseTo(1.2 * 1.2 ** 3, 6);
  });

  it("lands where the preview showed: the point under the cursor, on ITS page, stays put", async () => {
    await mounted();
    mockLayout();
    const el = scroller();
    const before = canvasBox(wraps()[0]);
    const s0 = before.w / 600;
    // Scrolled so the second page sits at the top of the viewport, cursor on it.
    el.scrollTop = 1_000;
    const wrapH0 = before.h + GAP;
    const cursorY = 100;
    const wrap1Top0 = PAD + wrapH0 - 1_000;
    const fy = (cursorY - wrap1Top0) / wrapH0;
    expect(fy).toBeGreaterThan(0);
    expect(fy).toBeLessThan(1);
    act(() => {
      el.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, clientX: 20, clientY: cursorY, bubbles: true, cancelable: true }),
      );
    });
    await waitFor(() => expect(io.renders).toBe(4), { timeout: PDF_ZOOM_COMMIT_MS * 10 });
    // The stack has relaid out at the committed scale; the observer applies the target.
    const after = canvasBox(wraps()[0]);
    expect(after.w / 600).toBeCloseTo(s0 * 1.2, 6);
    act(() => relaidOut());
    // That fraction of the (taller) second page is back under the cursor. A
    // target scaled against the whole stack would miss by the padding's and
    // the first page's gap's share of the growth.
    const wrapH1 = after.h + GAP;
    expect(el.scrollTop).toBeCloseTo(PAD + wrapH1 + fy * wrapH1 - cursorY, 3);
    expect(el.scrollTop).not.toBeCloseTo((1_000 + cursorY) * 1.2 - cursorY, 0);
  });

  it("commits nothing, and leaves no scroll target, when the gesture wheels back to where it began", async () => {
    await mounted();
    mockLayout();
    const el = scroller();
    const label = zoomLabel();
    act(() => {
      tick(-100);
      tick(100);
    });
    expect(zoomLabel()).toBe(label);
    await act(() => sleep(PDF_ZOOM_COMMIT_MS * 3));
    expect(io.renders).toBe(2);
    expect(scaleWrites).toEqual([]);
    expect(stack().style.transform).toBe("");
    // A later relayout (a window resize, a page painting) must not drag the
    // scroller back to where it was during the gesture.
    el.scrollTop = 777;
    act(() => relaidOut());
    expect(el.scrollTop).toBe(777);
  });

  it("zooms out the same way, and the +/− buttons still zoom at once", async () => {
    await mounted();
    act(() => tick(100));
    expect(zoomLabel()).toBe("100%");
    await waitFor(() => expect(io.renders).toBe(4), { timeout: PDF_ZOOM_COMMIT_MS * 10 });
    expect(scaleWrites).toHaveLength(1);
    // The button commits any preview still pending and steps from there.
    act(() => tick());
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect(scaleWrites).toHaveLength(2));
    expect(scaleWrites[1]).toBeCloseTo(1.2 * 1.2, 6);
    await waitFor(() => expect(io.renders).toBe(6), { timeout: PDF_ZOOM_COMMIT_MS * 10 });
    await sleep(PDF_ZOOM_COMMIT_MS * 2);
    expect(io.renders).toBe(6);
    expect(scaleWrites).toHaveLength(2);
  });
});
