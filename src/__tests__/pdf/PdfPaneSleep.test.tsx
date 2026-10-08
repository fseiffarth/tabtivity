/**
 * Sleeping tabs with a real viewer (performance plan §5.3, S9): a PDF tab's
 * whole pane (`PaneSlot` → `TabPane` → `FileViewerPane` → `PdfView`) sleeps
 * after the setting's delay — the document is destroyed, the `TabEntry` keeps
 * the position — and wakes at the zoom and scroll the reader left it at (the
 * §3.1 stage folded in by the unmount). A build of the file holds the pane
 * awake through `usePaneSleepHold`.
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

import { PaneSlot, type PaneSlotProps } from "../../components/layout/PaneSlot";
import { usePdfSyncStore } from "../../stores/viewers/pdfSync";
import { flushViewerState, useTabsStore, type TabEntry } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";

const PATH = "/home/u/paper/paper.pdf";
const TAB = "embed-7";
const SLEEP_MS = 60_000;

class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

const zoomLabel = () => document.querySelector(".file-viewer-zoom-level")?.textContent;
const scroller = () => document.querySelector<HTMLDivElement>(".file-viewer-pdf-scroll");
const pages = () => document.querySelectorAll(".file-viewer-pdf-page").length;
const tab = () => useTabsStore.getState().tabsByScope.p1[0];

function tabFor(viewerState?: TabEntry["viewerState"]): TabEntry {
  return {
    key: TAB,
    label: "paper.pdf",
    cmd: "",
    cwd: "/home/u/paper",
    kind: "embed",
    embedPath: PATH,
    viewer: "pdf",
    viewerState,
  } as TabEntry;
}

const onConnect = () => {};
const ready = new Map<string, boolean>();
function slot(visible: boolean) {
  const props: PaneSlotProps = {
    tab: tab(),
    scopeKey: "p1",
    groupId: "g1",
    visible,
    focused: visible,
    paneProject: undefined,
    paneBox: undefined,
    projectSsh: undefined,
    hostSsh: undefined,
    localPersistEnabled: false,
    onConnect,
    mobileAgentTmuxReady: ready,
    sleepAfterMs: SLEEP_MS,
    inPopout: false,
  };
  return <PaneSlot {...props} />;
}

async function shown() {
  const view = render(slot(true));
  await waitFor(() => expect(pages()).toBe(2));
  await waitFor(() => expect(zoomLabel()).toBe("150%"));
  await waitFor(() => expect(scroller()?.scrollTop).toBe(640));
  return view;
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
  useProjectsStore.setState({ projects: [], activeId: null, rootDir: "/r" });
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: { p1: [tabFor({ scale: 1.5, pdfFitted: false, scrollTop: 640 })] },
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
    tabs: [],
    layout: null,
  });
  // Every 2D call is a no-op (the PDF pages and the presentation overlay draw).
  const ctx2d = new Proxy({}, { get: () => () => {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx2d as unknown as CanvasRenderingContext2D,
  );
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
  vi.restoreAllMocks();
});

describe("a sleeping PDF pane", () => {
  it("unmounts the viewer after the delay and wakes at the reader's zoom and scroll", async () => {
    const view = await shown();
    const el = scroller()!;
    el.scrollTop = 900;
    act(() => {
      el.dispatchEvent(new Event("scroll"));
    });
    // The 200 ms scroll persist lands in the §3.1 stage.
    await new Promise<void>((r) => setTimeout(r, 250));

    vi.useFakeTimers();
    view.rerender(slot(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLEEP_MS);
    });
    // The whole pane is the stand-in: no viewer, no document.
    expect(document.querySelector("[data-sleeping=embed]")).not.toBeNull();
    expect(document.querySelector(".file-viewer")).toBeNull();
    expect(io.docsDestroyed).toBe(1);
    // The viewer's unmount folded the staged scroll into the tab.
    expect(tab().viewerState?.scrollTop).toBe(900);
    expect(tab().viewerState?.scale).toBe(1.5);

    vi.useRealTimers();
    view.rerender(slot(true));
    expect(document.querySelector("[data-sleeping=embed]")).toBeNull();
    await waitFor(() => expect(pages()).toBe(2));
    expect(io.opened).toBe(2);
    await waitFor(() => expect(zoomLabel()).toBe("150%"));
    await waitFor(() => expect(scroller()?.scrollTop).toBe(900));
  });

  it("stays awake while a build rewrites the file, then sleeps the full delay after it ends", async () => {
    const view = await shown();
    act(() => usePdfSyncStore.getState().applyCompile(PATH, true));
    vi.useFakeTimers();
    view.rerender(slot(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLEEP_MS * 3);
    });
    expect(document.querySelector("[data-sleeping=embed]")).toBeNull();
    expect(document.querySelector(".file-viewer")).not.toBeNull();

    act(() => usePdfSyncStore.getState().applyCompile(PATH, false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLEEP_MS - 1);
    });
    expect(document.querySelector("[data-sleeping=embed]")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(document.querySelector("[data-sleeping=embed]")).not.toBeNull();
  });
});
