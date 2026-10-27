/**
 * Reloading a PDF a compiler is rewriting (`PdfViewer.tsx`, performance plan
 * §4.4). Three things keep a multi-second build from moving the whole file
 * over IPC again and again:
 *
 * - a same-path reload stats the size twice (`RELOAD_SETTLE_MS` apart) and
 *   reads only once the two agree — a stat per retry instead of a read;
 * - while a TeX editor's build of this PDF is running (`beginCompile`), the
 *   mtime poll stands down, and the build's own reload request at the end is
 *   the one read;
 * - a reload with the same page count and unchanged first and last pages keeps
 *   the reserved page sizes instead of asking the worker about every page.
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  mtime: 1_000,
  /** What `file_size` answers, in order; the last value repeats. `null` = the
   *  command is unknown (an older backend). */
  sizes: [] as (number | null)[],
  /** Every IPC that matters, in order: "read" or "size:<n>". */
  events: [] as string[],
  /** `getPage` calls by page number. */
  pagesAsked: {} as Record<number, number>,
  /** A page's own [width, height] in points, where it is not 600 × 800. */
  pageSize: {} as Record<number, [number, number]>,
  invoke: vi.fn(),
}));

/** A five-page pdf.js document: 600 × 800 points (unless `io.pageSize` says
 *  otherwise for a page), nothing drawn, no text. */
vi.mock("pdfjs-dist", () => {
  const viewport = (
    [pw, ph]: [number, number],
    { scale = 1, rotation = 0 }: { scale?: number; rotation?: number } = {},
  ) => {
    const turned = rotation % 180 !== 0;
    const width = (turned ? ph : pw) * scale;
    const height = (turned ? pw : ph) * scale;
    return {
      width,
      height,
      scale,
      rotation,
      transform: [scale, 0, 0, -scale, 0, height],
      viewBox: [0, 0, pw, ph],
      clone: () => viewport([pw, ph], { scale, rotation }),
      convertToViewportPoint: (x: number, y: number) => [x * scale, height - y * scale],
      convertToPdfPoint: (x: number, y: number) => [x / scale, (height - y) / scale],
    };
  };
  const page = (n: number) => {
    const size = io.pageSize[n] ?? ([600, 800] as [number, number]);
    return {
      rotate: 0,
      view: [0, 0, size[0], size[1]],
      getViewport: (opts?: { scale?: number; rotation?: number }) => viewport(size, opts),
      render: () => ({ promise: Promise.resolve(), cancel() {} }),
      getTextContent: async () => ({ items: [], styles: {} }),
      getAnnotations: async () => [],
      getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
      cleanup() {},
    };
  };
  const doc = () => ({
    numPages: 5,
    getPage: async (n: number) => {
      io.pagesAsked[n] = (io.pagesAsked[n] ?? 0) + 1;
      return page(n);
    },
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

import { PdfView, RELOAD_SETTLE_MS } from "../../components/embed/pdf/PdfViewer";
import { FileScopeContext } from "../../lib/files/fileAccess";
import { usePdfSyncStore } from "../../stores/viewers/pdfSync";

const PATH = "/home/u/paper/paper.pdf";

/** No page is ever near the viewport: nothing renders, so the only per-page
 *  reads are the viewer's own metadata pass. */
class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

/** Every page is near the viewport from the moment it is observed. */
class EveryPageNearStub {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.cb([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

const reads = () => io.events.filter((e) => e === "read").length;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function mounted() {
  const view = render(
    <FileScopeContext.Provider value="p1">
      <PdfView path={PATH} onOpenExternally={() => {}} />
    </FileScopeContext.Provider>,
  );
  await waitFor(() => expect(document.querySelectorAll(".file-viewer-pdf-page-wrap").length).toBe(5));
  await waitFor(() => expect(Object.keys(io.pagesAsked).length).toBe(5));
  await sleep(50);
  return view;
}

beforeEach(() => {
  io.mtime = 1_000;
  io.sizes = [];
  io.events = [];
  io.pagesAsked = {};
  io.pageSize = {};
  io.invoke.mockReset();
  io.invoke.mockImplementation(async (command: string) => {
    if (command === "read_file_bytes") {
      io.events.push("read");
      return [37, 80, 68, 70];
    }
    if (command === "file_mtime") return io.mtime;
    if (command === "file_size") {
      const size = io.sizes.length > 1 ? io.sizes.shift()! : io.sizes[0] ?? null;
      io.events.push(`size:${size}`);
      return size;
    }
    return null;
  });
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IntersectionObserverStub;
  usePdfSyncStore.setState({ byPath: {}, reloadByPath: {}, compilingByPath: {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
  vi.restoreAllMocks();
});

describe("reading a PDF the compiler is rewriting", () => {
  it("opens with one read and no stat", async () => {
    await mounted();
    expect(io.events).toEqual(["read"]);
  });

  it("reads a rewritten file once its size has held still", async () => {
    await mounted();
    io.sizes = [100, 200, 200];
    io.mtime = 2_000;
    await waitFor(() => expect(reads()).toBe(2), { timeout: 6_000 });
    // Stat, stat (grew), stat (held) — then the one read.
    expect(io.events.slice(1)).toEqual(["size:100", "size:200", "size:200", "read"]);
  });

  it("reads at once on a backend without the size command", async () => {
    await mounted();
    io.sizes = [null];
    io.mtime = 2_000;
    await waitFor(() => expect(reads()).toBe(2), { timeout: 6_000 });
    expect(io.events.slice(1)).toEqual(["size:null", "read"]);
  });

  it("stands its poll down while a build runs and reads once when the build asks", async () => {
    await mounted();
    act(() => usePdfSyncStore.getState().beginCompile(PATH));
    io.mtime = 2_000;
    await sleep(2_500);
    expect(reads()).toBe(1);
    // The build is over: it asks for the one reload, then releases the hold.
    act(() => {
      usePdfSyncStore.getState().requestReload(PATH);
      usePdfSyncStore.getState().endCompile(PATH);
    });
    await waitFor(() => expect(reads()).toBe(2));
    // The resumed poll sees the mtime the reload recorded — no second read.
    await sleep(2_000);
    expect(reads()).toBe(2);
  });

  it("keeps the reserved page sizes across a reload that changed neither the count nor the ends", async () => {
    await mounted();
    io.pagesAsked = {};
    act(() => usePdfSyncStore.getState().applyReload(PATH));
    await waitFor(() => expect(reads()).toBe(2));
    await sleep(RELOAD_SETTLE_MS);
    // Only the first and last page were asked about; the middle was not.
    expect(io.pagesAsked[1]).toBeGreaterThan(0);
    expect(io.pagesAsked[5]).toBeGreaterThan(0);
    expect(io.pagesAsked[2] ?? 0).toBe(0);
    expect(io.pagesAsked[3] ?? 0).toBe(0);
    expect(io.pagesAsked[4] ?? 0).toBe(0);
  });

  it("corrects a middle page the build resized under a kept measurement", async () => {
    // Pages are near, so they render — and a render has the page in hand.
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = EveryPageNearStub;
    await mounted();
    // With no 2D context (beforeEach) the render stops after its size check, so
    // the page canvas keeps the box the RESERVED page size gives it — what a
    // remark, a markup stroke or a link box is laid out by too.
    const layers = () => [...document.querySelectorAll<HTMLElement>("canvas.file-viewer-pdf-page")];
    await waitFor(() => expect(layers().length).toBe(5));
    const scale = parseFloat(layers()[0].style.width) / 600;
    expect(scale).toBeGreaterThan(0);
    // The build turned page 3 landscape; the count and both end pages are as
    // they were, so the reload keeps the measured sizes …
    io.pageSize[3] = [800, 600];
    io.pagesAsked = {};
    act(() => usePdfSyncStore.getState().applyReload(PATH));
    await waitFor(() => expect(reads()).toBe(2));
    // … and the page's own render corrects the one that changed.
    await waitFor(() => expect(layers()[2].style.width).toBe(`${800 * scale}px`));
    expect(layers()[2].style.height).toBe(`${600 * scale}px`);
    expect(layers().map((l) => l.style.width)).toEqual(
      [600, 600, 800, 600, 600].map((w) => `${w * scale}px`),
    );
    // The correction is what the next reload compares against: still kept, still right.
    act(() => usePdfSyncStore.getState().applyReload(PATH));
    await waitFor(() => expect(reads()).toBe(3));
    await sleep(RELOAD_SETTLE_MS);
    expect(layers()[2].style.width).toBe(`${800 * scale}px`);
  });
});
