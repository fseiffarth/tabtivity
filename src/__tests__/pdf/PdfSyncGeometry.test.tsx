/**
 * SyncTeX on the PDF side (`PdfViewer.tsx` `PdfPageCanvas`/`PdfView`):
 *  - the forward-search highlight goes away after `SYNC_HIGHLIGHT_MS`, which under
 *    reduced motion (no fade) was the only thing that could remove it;
 *  - on a turned page (`/Rotate 90`, as `pdflscape` writes) the highlight is drawn
 *    where the box is on the TURNED page, and a Ctrl+click is handed to reverse
 *    search in the page's own unturned space;
 *  - a recompile's reveal is placed (and scrolled to) with the NEW document's
 *    page, not the geometry kept from the old one;
 *  - a reveal into a hidden pane waits: its clock does not run and it scrolls
 *    once the pane is shown;
 *  - a PDF read from the remote host asks SyncTeX nothing and says why;
 *  - a PDF with no map still opens the `.tex` that built it, at its top.
 *
 * The viewport below is pdf.js's own transform written out; the conversions it
 * feeds are pinned against the real `PageViewport` in `PdfjsContract.test.ts`.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  invoke: vi.fn(),
  rotate: 0,
  /** Every `scrollIntoPdfBox` call on a SyncTeX highlight: where the box was then. */
  scrolls: [] as { left: string; top: string }[],
  /** What the mocked `scrollIntoPdfBox` reports: is the pane laid out? */
  laidOut: true,
}));

/** A one-page document, 612 × 792 points, whose page carries `/Rotate io.rotate`.
 *  The viewport does pdf.js's own transform, so turned geometry is real. */
vi.mock("pdfjs-dist", () => {
  const view = [0, 0, 612, 792];
  const viewport = ({ scale = 1, rotation = 0 }: { scale?: number; rotation?: number } = {}) => {
    const [x1, y1, x2, y2] = view;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const r = ((rotation % 360) + 360) % 360;
    const [a, b, c, d] =
      r === 90 ? [0, 1, 1, 0] : r === 180 ? [-1, 0, 0, 1] : r === 270 ? [0, -1, -1, 0] : [1, 0, 0, -1];
    const ox = (a === 0 ? Math.abs(cy - y1) : Math.abs(cx - x1)) * scale;
    const oy = (a === 0 ? Math.abs(cx - x1) : Math.abs(cy - y1)) * scale;
    const t = [a * scale, b * scale, c * scale, d * scale, ox - a * scale * cx - c * scale * cy, oy - b * scale * cx - d * scale * cy];
    const turned = r % 180 !== 0;
    const width = (turned ? 792 : 612) * scale;
    const height = (turned ? 612 : 792) * scale;
    return {
      width,
      height,
      scale,
      rotation: r,
      transform: t,
      viewBox: view,
      clone: () => viewport({ scale, rotation }),
      convertToViewportPoint: (x: number, y: number) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]],
      convertToPdfPoint: (x: number, y: number) => {
        const det = t[0] * t[3] - t[1] * t[2];
        return [(t[3] * (x - t[4]) - t[2] * (y - t[5])) / det, (-t[1] * (x - t[4]) + t[0] * (y - t[5])) / det];
      },
    };
  };
  const page = () => ({
    rotate: io.rotate,
    view,
    getViewport: viewport,
    render: () => ({ promise: Promise.resolve(), cancel() {} }),
    getTextContent: async () => ({ items: [], styles: {} }),
    getAnnotations: async () => [],
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    cleanup() {},
  });
  const doc = () => ({
    numPages: 1,
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
vi.mock("../../components/embed/pdf/scrollBox", () => ({
  scrollIntoPdfBox: (el: HTMLElement) => {
    if (!io.laidOut) return false;
    if (el.classList.contains("file-viewer-pdf-sync-highlight")) {
      io.scrolls.push({ left: el.style.left, top: el.style.top });
    }
    return true;
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: io.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { PdfView, SYNC_HIGHLIGHT_MS } from "../../components/embed/pdf/PdfViewer";
import { FileScopeContext, FileSourceContext, PaneVisibleContext, type FileSource } from "../../components/embed/fileAccess";
import { usePdfSyncStore } from "../../stores/viewers/pdfSync";
import { useEditorJumpStore } from "../../stores/viewers/editorJump";
import { flushViewerState, useTabsStore, type TabEntry } from "../../stores/tabs";

const PATH = "/home/u/paper/paper.pdf";
const TAB = "embed-3";
const BOX = { page: 1, x: 72, y: 100, w: 200, h: 12 };

const highlight = () => document.querySelector<HTMLElement>(".file-viewer-pdf-sync-highlight");

function viewer(source: FileSource = "none", visible = true) {
  return (
    <PaneVisibleContext.Provider value={visible}>
      <FileSourceContext.Provider value={source}>
        <FileScopeContext.Provider value="p1">
          <PdfView path={PATH} tabKey={TAB} onOpenExternally={() => {}} />
        </FileScopeContext.Provider>
      </FileSourceContext.Provider>
    </PaneVisibleContext.Provider>
  );
}

async function shown(source: FileSource = "none") {
  const view = render(viewer(source));
  await waitFor(() => expect(document.querySelectorAll(".file-viewer-pdf-page").length).toBe(1));
  // The SyncTeX map probe (`syncable`) has answered.
  await act(async () => {});
  return view;
}

beforeEach(() => {
  io.rotate = 0;
  io.scrolls = [];
  io.laidOut = true;
  io.invoke.mockReset();
  io.invoke.mockImplementation(async (command: string) => {
    if (command === "read_file_bytes") return [37, 80, 68, 70];
    if (command === "file_mtime") return 1_000;
    return null;
  });
  usePdfSyncStore.setState({ byPath: {}, reloadByPath: {}, compilingByPath: {} });
  flushViewerState();
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: {
      p1: [{
        key: TAB,
        label: "paper.pdf",
        cmd: "",
        cwd: "/home/u/paper",
        kind: "embed",
        embedPath: PATH,
        viewer: "pdf",
        viewerState: { scale: 1, pdfFitted: false },
      } as TabEntry],
    },
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
  vi.restoreAllMocks();
});

describe("SyncTeX on the PDF side", () => {
  it("clears the forward-search highlight after its fade, reduced motion or not", async () => {
    await shown();
    vi.useFakeTimers();
    await act(async () => {
      usePdfSyncStore.getState().requestReveal(PATH, BOX);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(highlight()).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SYNC_HIGHLIGHT_MS - 1);
    });
    expect(highlight()).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(highlight()).toBeNull();
  });

  it("draws the highlight on a turned page where the box is once turned", async () => {
    io.rotate = 90;
    await shown();
    act(() => usePdfSyncStore.getState().requestReveal(PATH, BOX));
    await waitFor(() => expect(highlight()).not.toBeNull());
    // Turned clockwise: the box's top edge (y 100..112) runs down the right side.
    const s = highlight()!.style;
    expect([s.left, s.top, s.width, s.height]).toEqual(["680px", "72px", "12px", "200px"]);
  });

  it("hands reverse search the unturned point of a Ctrl+click on a turned page", async () => {
    io.rotate = 90;
    await shown();
    const wrap = document.querySelector(".file-viewer-pdf-page-wrap")!;
    // jsdom lays the canvas out at (0, 0), so client coordinates are canvas-local.
    await act(async () => {
      fireEvent.click(wrap, { ctrlKey: true, clientX: 686, clientY: 172 });
    });
    await waitFor(() =>
      expect(io.invoke).toHaveBeenCalledWith("synctex_edit", { pdf: PATH, page: 1, x: 172, y: 106 }),
    );
  });

  it("places a recompile's reveal with the new document's page, not the old one's", async () => {
    await shown();
    vi.useFakeTimers();
    await act(async () => {
      usePdfSyncStore.getState().requestReveal(PATH, BOX);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(io.scrolls).toEqual([{ left: "72px", top: "100px" }]);
    // The flash ends, so nothing refetches the page while the new document loads.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SYNC_HIGHLIGHT_MS);
    });
    expect(highlight()).toBeNull();
    vi.useRealTimers();
    // The build turned the page; its reveal rides the reload of the new bytes.
    io.rotate = 90;
    act(() => usePdfSyncStore.getState().requestReveal(PATH, BOX, undefined, true));
    await waitFor(() => expect(io.scrolls).toHaveLength(2));
    expect(io.scrolls[1]).toEqual({ left: "680px", top: "72px" });
    expect(highlight()!.style.left).toBe("680px");
  });

  it("holds a reveal into a hidden pane, then scrolls to it and starts its clock on show", async () => {
    const view = await shown();
    io.laidOut = false;
    view.rerender(viewer("none", false));
    vi.useFakeTimers();
    await act(async () => {
      usePdfSyncStore.getState().requestReveal(PATH, BOX);
      await vi.advanceTimersByTimeAsync(SYNC_HIGHLIGHT_MS * 3);
    });
    // Still there, never scrolled to: nothing could be shown.
    expect(highlight()).not.toBeNull();
    expect(io.scrolls).toEqual([]);
    io.laidOut = true;
    view.rerender(viewer("none", true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(io.scrolls).toEqual([{ left: "72px", top: "100px" }]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SYNC_HIGHLIGHT_MS);
    });
    expect(highlight()).toBeNull();
  });

  it("asks SyncTeX nothing for a PDF read from the remote host, and says so", async () => {
    await shown("remote");
    // No map or source probe over SFTP either: the source is looked for on a click.
    expect(io.invoke).not.toHaveBeenCalledWith("file_mtime", expect.objectContaining({ path: expect.stringMatching(/synctex|\.tex$/) }));
    await act(async () => {
      fireEvent.click(document.querySelector(".file-viewer-pdf-page-wrap")!, { ctrlKey: true, clientX: 50, clientY: 50 });
    });
    // …which still opens the `.tex` beside it, at its top.
    await screen.findByText(/isn't available for a file read from the remote host, so paper\.tex opened at its top/i);
    expect(io.invoke).not.toHaveBeenCalledWith("synctex_edit", expect.anything());
    expect(io.invoke).not.toHaveBeenCalledWith("synctex_status", expect.anything());
  });

  describe("a PDF with no SyncTeX map", () => {
    /** `file_mtime` answers for `present` only: every other path is missing. */
    const onDisk = (present: string[]) =>
      io.invoke.mockImplementation(async (command: string, args?: { path?: string }) => {
        if (command === "read_file_bytes") return [37, 80, 68, 70];
        if (command === "file_mtime") {
          if (args?.path === PATH || present.includes(args?.path ?? "")) return 1_000;
          throw new Error("not found");
        }
        return null;
      });
    const ctrlClick = () =>
      act(async () => {
        fireEvent.click(document.querySelector(".file-viewer-pdf-page-wrap")!, { ctrlKey: true, clientX: 50, clientY: 50 });
      });

    beforeEach(() => useEditorJumpStore.setState({ requestsByPath: {} }));

    it("opens the .tex beside it at its top, and says why", async () => {
      onDisk(["/home/u/paper/paper.tex"]);
      await shown();
      await ctrlClick();
      await screen.findByText(/paper\.tex opened at its top/i);
      expect(useEditorJumpStore.getState().requestsByPath["/home/u/paper/paper.tex"]?.line).toBe(1);
      expect(io.invoke).not.toHaveBeenCalledWith("synctex_edit", expect.anything());
    });

    it("finds the source one folder up for an -outdir build", async () => {
      onDisk(["/home/u/paper.tex"]);
      await shown();
      await ctrlClick();
      await screen.findByText(/paper\.tex opened at its top/i);
      expect(useEditorJumpStore.getState().requestsByPath["/home/u/paper.tex"]?.line).toBe(1);
    });

    it("keeps the plain notice when no source sits by its name either", async () => {
      onDisk([]);
      await shown();
      await ctrlClick();
      await screen.findByText(/cannot be matched up/i);
      expect(useEditorJumpStore.getState().requestsByPath).toEqual({});
    });
  });
});
