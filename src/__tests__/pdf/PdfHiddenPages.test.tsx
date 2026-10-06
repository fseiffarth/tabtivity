/**
 * Painted PDF pages across a tab switch (`PdfViewer.tsx`, performance plan
 * §4.2). Hiding the pane makes the IntersectionObserver report every page as
 * not intersecting, which used to release every near page's canvas at once and
 * re-decode and repaint all of them on the way back. Now a page hidden with its
 * pane keeps its pixels for `PDF_PAGE_RELEASE_MS`, is released after, and a
 * document that changed while hidden is repainted on show, not in the dark.
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  renders: 0,
  fingerprints: 0,
  invoke: vi.fn(),
}));

/** A two-page pdf.js document: 600 × 800 points, nothing drawn, no text. Every
 *  `page.render` and every `getOperatorList` (the fingerprint) is counted. */
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
    getOperatorList: async () => {
      io.fingerprints += 1;
      return { fnArray: [], argsArray: [] };
    },
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

import { PdfView, PDF_PAGE_RELEASE_MS } from "../../components/embed/pdf/PdfViewer";
import { FileScopeContext, PaneVisibleContext } from "../../components/embed/fileAccess";
import { usePdfSyncStore } from "../../stores/viewers/pdfSync";

const PATH = "/home/u/paper/paper.pdf";

/** The page observers the viewer created: jsdom has no IntersectionObserver,
 *  so this stand-in records each one and lets a test report what the engine
 *  would — every page near, or (a hidden pane) every page not intersecting. */
const observers: { cb: IntersectionObserverCallback; opts?: IntersectionObserverInit; targets: Element[] }[] = [];
class IntersectionObserverStub {
  private rec: (typeof observers)[number];
  constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
    this.rec = { cb, opts, targets: [] };
    observers.push(this.rec);
  }
  observe(el: Element) { this.rec.targets.push(el); }
  unobserve() {}
  disconnect() { this.rec.targets = []; }
  takeRecords() { return []; }
}
function report(isIntersecting: boolean) {
  for (const o of observers) {
    if (o.targets.length === 0) continue;
    o.cb(
      o.targets.map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry),
      o as unknown as IntersectionObserver,
    );
  }
}

const canvases = () => [...document.querySelectorAll<HTMLCanvasElement>(".file-viewer-pdf-page")];
const painted = () => canvases().map((c) => c.width > 0);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function viewer(visible: boolean) {
  return (
    <PaneVisibleContext.Provider value={visible}>
      <FileScopeContext.Provider value="p1">
        <PdfView path={PATH} onOpenExternally={() => {}} />
      </FileScopeContext.Provider>
    </PaneVisibleContext.Provider>
  );
}

/** Mount visible, bring both pages near, wait until they are painted. */
async function shown() {
  const view = render(viewer(true));
  await waitFor(() => expect(canvases().length).toBe(2));
  act(() => report(true));
  await waitFor(() => expect(io.renders).toBe(2));
  await waitFor(() => expect(painted()).toEqual([true, true]));
  await sleep(50);
  expect(io.fingerprints).toBe(2);
  return view;
}

beforeEach(() => {
  io.renders = 0;
  io.fingerprints = 0;
  io.invoke.mockReset();
  io.invoke.mockImplementation(async (command: string) => {
    if (command === "read_file_bytes") return [37, 80, 68, 70];
    if (command === "file_mtime") return 1_000;
    return null;
  });
  observers.length = 0;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IntersectionObserverStub;
  usePdfSyncStore.setState({ byPath: {}, reloadByPath: {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage() {},
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
  vi.restoreAllMocks();
});

describe("painted pages across a tab switch", () => {
  it("watches a screenful either side of the viewport", async () => {
    await shown();
    expect(observers.map((o) => o.opts?.rootMargin)).toEqual(["100% 0px", "100% 0px"]);
  });

  it("keeps a hidden pane's pages painted until the release timer, then frees them", async () => {
    const view = await shown();
    vi.useFakeTimers();
    view.rerender(viewer(false));
    act(() => report(false));
    // Still painted, nothing rendered again.
    expect(painted()).toEqual([true, true]);
    act(() => vi.advanceTimersByTime(PDF_PAGE_RELEASE_MS - 1));
    expect(painted()).toEqual([true, true]);
    act(() => vi.advanceTimersByTime(1));
    expect(painted()).toEqual([false, false]);
    expect(io.renders).toBe(2);
  });

  it("repaints nothing when the pane is shown again within the window", async () => {
    const view = await shown();
    vi.useFakeTimers();
    view.rerender(viewer(false));
    act(() => report(false));
    act(() => vi.advanceTimersByTime(PDF_PAGE_RELEASE_MS / 2));
    view.rerender(viewer(true));
    act(() => report(true));
    act(() => vi.advanceTimersByTime(PDF_PAGE_RELEASE_MS));
    expect(painted()).toEqual([true, true]);
    expect(io.renders).toBe(2);
    expect(io.fingerprints).toBe(2);
  });

  it("releases a page the shown pane is no longer near at once", async () => {
    const view = await shown();
    vi.useFakeTimers();
    view.rerender(viewer(false));
    act(() => report(false));
    view.rerender(viewer(true));
    // The engine reports the real intersection on show: scrolled away meanwhile.
    act(() => report(false));
    expect(painted()).toEqual([false, false]);
  });

  it("paints a document that changed while hidden on show, not in the dark", async () => {
    const view = await shown();
    view.rerender(viewer(false));
    act(() => report(false));
    // A compile's re-read lands while the tab is behind another.
    act(() => usePdfSyncStore.getState().applyReload(PATH));
    await waitFor(() => expect(io.invoke.mock.calls.filter(([c]) => c === "read_file_bytes").length).toBe(2));
    await sleep(50);
    expect(io.renders).toBe(2);
    expect(io.fingerprints).toBe(2);
    expect(painted()).toEqual([true, true]);
    view.rerender(viewer(true));
    act(() => report(true));
    // The fresh document is compared against the pixels on screen — same
    // drawing, so they stay — and nothing was rendered while hidden.
    await waitFor(() => expect(io.fingerprints).toBe(4));
    expect(io.renders).toBe(2);
    expect(painted()).toEqual([true, true]);
  });
});
