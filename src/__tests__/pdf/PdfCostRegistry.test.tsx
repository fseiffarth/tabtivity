/**
 * The tab cost registry's PDF side (`lib/tabCost`, `docs/done/tab_cost_plan.md`
 * step 1): a `PdfCanvas` registers when it mounts, reports its pages and bytes
 * once its document is up, and leaves when it unmounts — so the §4.3 release
 * of a hidden PDF drops the loaded count by one and a show brings it back.
 * Harness of `PdfSleepHidden.test.tsx`.
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
import { _clearTabCostForTest, loadedPdfCount, pdfCostFor } from "../../lib/tabCost";

const PATH = "/home/u/paper/paper.pdf";
const TAB = "embed-7";

class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}


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
async function hiddenPast(view: ReturnType<typeof render>, ms: number, tabKey: string = TAB) {
  vi.useFakeTimers();
  view.rerender(viewer(false, PATH, tabKey));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  _clearTabCostForTest();
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

describe("the PDF cost registry", () => {
  it("counts a loaded viewer, drops it on the hidden release and on unmount, and counts it again on show", async () => {
    expect(loadedPdfCount()).toBe(0);
    const view = await shown();
    await waitFor(() => expect(loadedPdfCount()).toBe(1));
    // The fake read returns four bytes, the fake document has two pages.
    expect(pdfCostFor(TAB)).toEqual({ entries: 1, docs: 1, pages: 2, bytes: 4, estBytes: 8 });
    await hiddenPast(view, PDF_DOC_RELEASE_MS);
    expect(document.querySelector("[data-sleeping=pdf]")).not.toBeNull();
    expect(loadedPdfCount()).toBe(0);
    expect(pdfCostFor(TAB)).toBeNull();
    vi.useRealTimers();
    view.rerender(viewer(true));
    await waitFor(() => expect(loadedPdfCount()).toBe(1));
    view.unmount();
    expect(loadedPdfCount()).toBe(0);
  });

  it("files a TeX workspace's PDF pane under its tab", async () => {
    const WS = "embed-ws";
    render(viewer(true, PATH, `${WS}#${PATH}`));
    await waitFor(() => expect(pdfCostFor(WS)).toMatchObject({ docs: 1, pages: 2 }));
  });
});
