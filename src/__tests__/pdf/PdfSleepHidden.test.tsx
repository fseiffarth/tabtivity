/**
 * A hidden PDF tab releases its document (`PdfViewer.tsx` `PdfView`,
 * performance plan §4.3). Every open PDF tab kept its parsed document and a
 * worker alive for as long as it was open, hidden or not. Now a pane hidden for
 * `PDF_DOC_RELEASE_MS` unmounts its canvas — the documents are destroyed, the
 * worker slot ends — and remounts on show, reloading at the persisted zoom and
 * scroll. Unsaved work, a build of the file and a popout mirror hold it awake.
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  opened: 0,
  docsDestroyed: 0,
  workersDestroyed: 0,
  invoke: vi.fn(),
}));

/** A two-page pdf.js document, 600 × 800 points. Opens, document teardowns and
 *  worker teardowns are counted. */
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
    render: () => ({ promise: Promise.resolve(), cancel() {} }),
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
    loadingTask: {
      destroy: async () => {
        io.docsDestroyed += 1;
      },
    },
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
      destroy() {
        this.destroyed = true;
        io.workersDestroyed += 1;
      }
    },
    TextLayer: class {
      render() { return Promise.resolve(); }
      cancel() {}
    },
    getDocument: () => {
      io.opened += 1;
      return { promise: Promise.resolve(doc()), destroy: async () => {} };
    },
  };
});
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: io.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { PdfView, PDF_DOC_RELEASE_MS } from "../../components/embed/pdf/PdfViewer";
import { FileScopeContext, PaneVisibleContext } from "../../components/embed/fileAccess";
import { usePdfSyncStore } from "../../stores/viewers/pdfSync";
import { flushViewerState, useTabsStore, type TabEntry } from "../../stores/tabs";

const PATH = "/home/u/paper/paper.pdf";
const TAB = "embed-7";

class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

const reads = () => io.invoke.mock.calls.filter(([c]) => c === "read_file_bytes").length;
const zoomLabel = () => document.querySelector(".file-viewer-zoom-level")?.textContent;
const scroller = () => document.querySelector<HTMLDivElement>(".file-viewer-pdf-scroll");

function viewer(visible: boolean, path = PATH, tabKey: string | undefined = TAB) {
  return (
    <PaneVisibleContext.Provider value={visible}>
      <FileScopeContext.Provider value="p1">
        <PdfView path={path} tabKey={tabKey} onOpenExternally={() => {}} />
      </FileScopeContext.Provider>
    </PaneVisibleContext.Provider>
  );
}

function tabFor(key: string, path: string, viewerState?: TabEntry["viewerState"]): TabEntry {
  return {
    key,
    label: "paper.pdf",
    cmd: "",
    cwd: "/home/u/paper",
    kind: "embed",
    embedPath: path,
    viewer: "pdf",
    viewerState,
  } as TabEntry;
}

/** Mount visible and wait until the document is up (two page slots). */
async function shown() {
  const view = render(viewer(true));
  await waitFor(() => expect(document.querySelectorAll(".file-viewer-pdf-page").length).toBe(2));
  expect(io.opened).toBe(1);
  return view;
}

/** Hide the viewer and run the clock to the release deadline. */
async function hiddenPast(view: ReturnType<typeof render>, ms: number) {
  vi.useFakeTimers();
  view.rerender(viewer(false));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  io.opened = 0;
  io.docsDestroyed = 0;
  io.workersDestroyed = 0;
  io.invoke.mockReset();
  io.invoke.mockImplementation(async (command: string) => {
    if (command === "read_file_bytes") return [37, 80, 68, 70];
    if (command === "file_mtime") return 1_000;
    return null;
  });
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IntersectionObserverStub;
  usePdfSyncStore.setState({ byPath: {}, reloadByPath: {}, compilingByPath: {} });
  flushViewerState();
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: { p1: [tabFor(TAB, PATH, { scale: 1.5, pdfFitted: false, scrollTop: 640 })] },
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
    tabs: [],
    layout: null,
  });
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

describe("a hidden PDF tab releases its document", () => {
  it("destroys the document and ends the worker after the release window, with no timer left", async () => {
    const view = await shown();
    await hiddenPast(view, PDF_DOC_RELEASE_MS - 1);
    expect(io.docsDestroyed).toBe(0);
    expect(document.querySelector("[data-sleeping=pdf]")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(document.querySelector("[data-sleeping=pdf]")).not.toBeNull();
    expect(document.querySelectorAll(".file-viewer-pdf-page").length).toBe(0);
    expect(io.docsDestroyed).toBe(1);
    // The worker slot ends once the document's teardown has settled.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(io.workersDestroyed).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reloads on show at the persisted zoom and scroll", async () => {
    const view = await shown();
    await waitFor(() => expect(zoomLabel()).toBe("150%"));
    await hiddenPast(view, PDF_DOC_RELEASE_MS);
    expect(io.docsDestroyed).toBe(1);
    const readsBefore = reads();
    vi.useRealTimers();
    view.rerender(viewer(true));
    // Awake in the same render: the sleeping slot is gone at once.
    expect(document.querySelector("[data-sleeping=pdf]")).toBeNull();
    await waitFor(() => expect(document.querySelectorAll(".file-viewer-pdf-page").length).toBe(2));
    expect(io.opened).toBe(2);
    expect(reads()).toBe(readsBefore + 1);
    // The persisted position, not the hidden element's (which reads 0).
    await waitFor(() => expect(zoomLabel()).toBe("150%"));
    await waitFor(() => expect(scroller()?.scrollTop).toBe(640));
  });

  it("restores the position the reader reached before hiding, not the one saved earlier", async () => {
    const view = await shown();
    const el = scroller()!;
    // The restore of the saved 640 settles first; then the reader scrolls on.
    await waitFor(() => expect(el.scrollTop).toBe(640));
    el.scrollTop = 900;
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    // The 200 ms scroll persist lands in the §3.1 stage; the hide folds it in.
    await new Promise<void>((r) => setTimeout(r, 250));
    await hiddenPast(view, PDF_DOC_RELEASE_MS);
    expect(useTabsStore.getState().tabsByScope.p1[0].viewerState?.scrollTop).toBe(900);
    vi.useRealTimers();
    view.rerender(viewer(true));
    await waitFor(() => expect(scroller()?.scrollTop).toBe(900));
  });

  it("answers a forward search that arrived while asleep on the wake", async () => {
    const view = await shown();
    await hiddenPast(view, PDF_DOC_RELEASE_MS);
    expect(io.docsDestroyed).toBe(1);
    // The editor's SyncTeX reveal lands by path; no canvas is mounted to take it.
    act(() => {
      usePdfSyncStore.getState().requestReveal(PATH, { page: 2, x: 72, y: 100, w: 200, h: 12 });
    });
    expect(usePdfSyncStore.getState().byPath[PATH]).toBeDefined();
    vi.useRealTimers();
    view.rerender(viewer(true));
    await waitFor(() => expect(document.querySelectorAll(".file-viewer-pdf-page").length).toBe(2));
    // The fresh canvas consumes it and shows the highlight on the page it names.
    await waitFor(() => expect(usePdfSyncStore.getState().byPath[PATH]).toBeUndefined());
    await waitFor(() => expect(document.querySelector(".file-viewer-pdf-sync-highlight")).not.toBeNull());
    const wraps = document.querySelectorAll(".file-viewer-pdf-page-wrap");
    expect(wraps).toHaveLength(2);
    expect(wraps[1].querySelector(".file-viewer-pdf-sync-highlight")).not.toBeNull();
    expect(wraps[0].querySelector(".file-viewer-pdf-sync-highlight")).toBeNull();
  });

  it("stays awake while a build is rewriting the file, then sleeps once it ends", async () => {
    const view = await shown();
    act(() => usePdfSyncStore.getState().applyCompile(PATH, true));
    await hiddenPast(view, PDF_DOC_RELEASE_MS * 2);
    expect(io.docsDestroyed).toBe(0);
    act(() => usePdfSyncStore.getState().applyCompile(PATH, false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PDF_DOC_RELEASE_MS - 1);
    });
    expect(io.docsDestroyed).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(io.docsDestroyed).toBe(1);
  });

  it("stays awake for a tab a popout mirrors", async () => {
    const view = await shown();
    useTabsStore.setState({
      detachedGroupsByScope: {
        p1: [{ id: "g9", label: "popout-g9", subtree: { type: "group", id: "g9", tabKeys: [TAB], activeKey: TAB } }],
      },
    });
    await hiddenPast(view, PDF_DOC_RELEASE_MS * 2);
    expect(io.docsDestroyed).toBe(0);
    expect(document.querySelectorAll(".file-viewer-pdf-page").length).toBe(2);
  });

  it("frees every document of ten hidden PDF tabs", async () => {
    const paths = Array.from({ length: 10 }, (_, i) => `/home/u/paper/ch${i}.pdf`);
    useTabsStore.setState({
      tabsByScope: { p1: paths.map((p, i) => tabFor(`embed-${i}`, p)) },
    });
    const views = paths.map((p, i) => render(viewer(true, p, `embed-${i}`)));
    await waitFor(() => expect(io.opened).toBe(10));
    await waitFor(() => expect(document.querySelectorAll(".file-viewer-pdf-page").length).toBe(20));
    vi.useFakeTimers();
    views.forEach((v, i) => v.rerender(viewer(false, paths[i], `embed-${i}`)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PDF_DOC_RELEASE_MS);
    });
    expect(io.docsDestroyed).toBe(10);
    expect(io.workersDestroyed).toBe(10);
    expect(document.querySelectorAll("[data-sleeping=pdf]").length).toBe(10);
  });
});
