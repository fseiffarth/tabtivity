/**
 * Markup mode inside the real PDF viewer (`PdfViewer.tsx`, plan §2.6), over a
 * stub pdf.js: where the Mark up button shows, what turning it on turns off,
 * and that every way the viewer learns its file changed — the mtime poll, a
 * compile's re-read request, a SyncTeX reveal after a compile — offers Reload
 * instead of repainting under the marks, and still repaints with markup off.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  mtime: 1_000,
  reads: 0,
  invoke: vi.fn(),
  loadLayer: vi.fn(),
  saveLayer: vi.fn(async () => true),
}));

/** A two-page pdf.js document: 600 × 800 points, nothing drawn, no text. */
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
vi.mock("../../../mobile-web/src/markup/store", async (original) => ({
  ...(await original<typeof import("../../../mobile-web/src/markup/store")>()),
  loadLayer: io.loadLayer,
  saveLayer: io.saveLayer,
}));

import { PdfView } from "../../components/embed/pdf/PdfViewer";
import { FileScopeContext, FileSourceContext, type FileSource } from "../../components/embed/fileAccess";
import { setDetachedWindowContext, type DetachedWindowContext } from "../../stores/detachedContext";
import { usePdfSyncStore } from "../../stores/viewers/pdfSync";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { _clearMarkupClaimsForTest } from "../../lib/viewers/pdfMarkup";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";
import { EMPTY_LAYER, addMark } from "../../../mobile-web/src/markup/layer";
import { readPenPrefs } from "../../../mobile-web/src/markup/pen";

const PATH = "/home/u/paper/paper.pdf";
const MARKED = addMark(EMPTY_LAYER, 1, [600, 800], { kind: "box", color: "yellow", rect: [10, 10, 50, 20] });

function viewer(scope: string | null = "p1", source: FileSource = "none") {
  return (
    <FileScopeContext.Provider value={scope}>
      <FileSourceContext.Provider value={source}>
        <PdfView path={PATH} onOpenExternally={() => {}} />
      </FileSourceContext.Provider>
    </FileScopeContext.Provider>
  );
}

const markUp = () => screen.queryByRole("button", { name: /Mark up/ }) as HTMLButtonElement | null;
/** The first render of the file is done: its pages are on screen. */
const loaded = () => waitFor(() => expect(document.querySelectorAll(".file-viewer-pdf-page-wrap").length).toBe(2));

beforeEach(() => {
  io.mtime = 1_000;
  io.reads = 0;
  io.invoke.mockReset();
  io.invoke.mockImplementation(async (command: string) => {
    if (command === "read_file_bytes") {
      io.reads += 1;
      return [37, 80, 68, 70];
    }
    if (command === "file_mtime") {
      if (command && io.mtime < 0) throw new Error("missing");
      return io.mtime;
    }
    return null;
  });
  io.loadLayer.mockReset();
  io.loadLayer.mockResolvedValue({ layer: MARKED, fingerprint: { size: 4, modified: 1_000 }, saved: 1 });
  io.saveLayer.mockClear();
  useTabsStore.setState({
    tabsByScope: { p1: [{ key: "t1", label: "Claude", cmd: "claude", cwd: "/home/u/paper", kind: "agent", scheduleTargetId: "s1" } as TabEntry] },
  });
  usePdfSyncStore.setState({ byPath: {}, reloadByPath: {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  setDetachedWindowContext(null);
  _clearMarkupClaimsForTest();
  vi.restoreAllMocks();
});

describe("Mark up in the PDF viewer", () => {
  it("is offered on a local project's PDF in the main window", async () => {
    render(viewer());
    await loaded();
    await waitFor(() => expect(markUp()).toBeTruthy());
    expect(markUp()!.disabled).toBe(false);
  });

  it.each([
    ["the root scope", () => viewer(null)],
    ["a box", () => viewer("box:b1")],
    ["a remote project", () => viewer("p1", "remote")],
  ])("is not offered for %s", async (_name, ui) => {
    render(ui());
    await loaded();
    expect(markUp()).toBeNull();
  });

  it("is not offered in a popout window", async () => {
    setDetachedWindowContext({ scope: "p1", groupId: "g", label: "detached-p1-g" } as DetachedWindowContext);
    render(viewer());
    await loaded();
    expect(markUp()).toBeNull();
  });

  it("turns the blackout tool off, puts the layer over the page and the remarks out of reach", async () => {
    const { container } = render(viewer());
    await loaded();
    // Before: a right-click on the page offers to place a remark.
    fireEvent.contextMenu(container.querySelector(".file-viewer-pdf-page-wrap")!);
    await waitFor(() => expect(document.querySelector(".file-viewer-pdf-note-menu")).toBeTruthy());
    fireEvent.keyDown(document.querySelector(".file-viewer-pdf-scroll")!, { key: "Escape" });
    fireEvent.pointerDown(document.body);
    fireEvent.click(screen.getByRole("button", { name: "Black out text" }));
    expect(container.querySelector(".file-viewer-pdf-redact-layer")).toBeTruthy();
    await waitFor(() => expect(markUp()!.disabled).toBe(false));
    fireEvent.click(markUp()!);
    expect(container.querySelector(".file-viewer-pdf-redact-layer")).toBeNull();
    expect(screen.getByRole("button", { name: "Black out text" }).getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelectorAll(".file-viewer-pdf-markup-layer").length).toBe(2);
    expect(container.querySelectorAll(".file-viewer-pdf-page-wrap.is-marking").length).toBe(2);
    // The page's own right-click (place a remark) is off while marking.
    const wrap = container.querySelector(".file-viewer-pdf-page-wrap")!;
    fireEvent.contextMenu(wrap);
    expect(document.querySelector(".file-viewer-pdf-note-menu")).toBeNull();
    // The arrangement holds still: rail and its undo are off.
    expect((screen.getByRole("button", { name: "Arrange pages" }) as HTMLButtonElement).disabled).toBe(true);
    // Escape leaves the mode.
    fireEvent.keyDown(container.querySelector(".file-viewer-pdf-scroll")!, { key: "Escape" });
    expect(container.querySelector(".file-viewer-pdf-markup-layer")).toBeNull();
  });

  it("mounts the markup canvas only on pages near the viewport", async () => {
    const watchers: { cb: IntersectionObserverCallback; targets: Element[] }[] = [];
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
      private rec: (typeof watchers)[number];
      constructor(cb: IntersectionObserverCallback) {
        this.rec = { cb, targets: [] };
        watchers.push(this.rec);
      }
      observe(el: Element) { this.rec.targets.push(el); }
      unobserve() {}
      disconnect() { this.rec.targets = []; }
      takeRecords() { return []; }
    };
    try {
      const { container } = render(viewer());
      await loaded();
      await waitFor(() => expect(watchers.flatMap((w) => w.targets).length).toBe(2));
      await waitFor(() => expect(markUp()!.disabled).toBe(false));
      fireEvent.click(markUp()!);
      expect(container.querySelectorAll(".file-viewer-pdf-page-wrap.is-marking").length).toBe(2);
      // Nothing is near: no page holds a markup canvas.
      expect(container.querySelectorAll(".file-viewer-pdf-markup-layer").length).toBe(0);
      const report = (hit: (el: Element) => boolean) => {
        for (const w of watchers) {
          const entries = w.targets.map((target) => ({ target, isIntersecting: hit(target) }) as IntersectionObserverEntry);
          if (entries.length) w.cb(entries, w as unknown as IntersectionObserver);
        }
      };
      const first = container.querySelector(".file-viewer-pdf-page-wrap")!;
      act(() => report((el) => el === first));
      expect(container.querySelectorAll(".file-viewer-pdf-markup-layer").length).toBe(1);
      act(() => report(() => false));
      expect(container.querySelectorAll(".file-viewer-pdf-markup-layer").length).toBe(0);
    } finally {
      delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
  });

  it("steers the pen bar from the keyboard and keeps the choices", async () => {
    localStorage.clear();
    const { container } = render(viewer());
    await loaded();
    await waitFor(() => expect(markUp()!.disabled).toBe(false));
    fireEvent.click(markUp()!);
    const scroll = container.querySelector(".file-viewer-pdf-scroll")!;
    const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");
    expect(pressed("Pen")).toBe("true");
    expect(screen.getByRole("button", { name: "Pen style: Plain pen" })).toBeTruthy();
    // P on the armed pen steps its style; the marker offers yellow as its 4th colour.
    fireEvent.keyDown(scroll, { key: "p" });
    expect(screen.getByRole("button", { name: "Pen style: Marker" })).toBeTruthy();
    fireEvent.keyDown(scroll, { key: "4" });
    expect(pressed("Colour: Yellow")).toBe("true");
    fireEvent.keyDown(scroll, { key: "]" });
    expect(pressed("Bold")).toBe("true");
    // E arms the eraser, E again its area mode.
    fireEvent.keyDown(scroll, { key: "e" });
    fireEvent.keyDown(scroll, { key: "e" });
    expect(pressed("Erase an area")).toBe("true");
    expect(container.querySelector(".file-viewer-pdf-markup-layer.is-area")).toBeTruthy();
    // The box keeps its own colour; the pen's yellow stays the marker's.
    fireEvent.keyDown(scroll, { key: "b" });
    expect(pressed("Highlighter")).toBe("true");
    expect(pressed("Colour: Yellow")).toBe("true");
    fireEvent.keyDown(scroll, { key: "1" });
    expect(pressed("Colour: Red")).toBe("true");
    // The clearing sits in the ⋯ menu.
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getAllByRole("menuitem").length).toBeGreaterThanOrEqual(2);
    expect(readPenPrefs()).toMatchObject({ tool: "box", style: "marker", size: 2, eraser: "area", colors: { ink: "yellow", box: "red" } });
    localStorage.clear();
  });

  it("arms the new tools, presets and the selection from the keyboard", async () => {
    localStorage.clear();
    const { container } = render(viewer());
    await loaded();
    await waitFor(() => expect(markUp()!.disabled).toBe(false));
    fireEvent.click(markUp()!);
    await waitFor(() => expect(io.loadLayer).toHaveBeenCalled());
    const scroll = container.querySelector(".file-viewer-pdf-scroll")!;
    const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");
    // M arms the text marks, M again steps their mode; K the stamp and its symbol.
    fireEvent.keyDown(scroll, { key: "m" });
    expect(pressed("Mark text")).toBe("true");
    expect(pressed("Highlight")).toBe("true");
    fireEvent.keyDown(scroll, { key: "m" });
    expect(pressed("Strike through")).toBe("true");
    fireEvent.keyDown(scroll, { key: "k" });
    expect(pressed("Stamp")).toBe("true");
    fireEvent.keyDown(scroll, { key: "k" });
    expect(pressed("Delete")).toBe("true");
    // Shift+2 arms the second preset (a yellow marker), Shift+3 the third (a
    // blue pen), by the key's place.
    fireEvent.keyDown(scroll, { key: "@", code: "Digit2", shiftKey: true });
    expect(screen.getByRole("button", { name: "Pen style: Marker" })).toBeTruthy();
    fireEvent.keyDown(scroll, { key: "#", code: "Digit3", shiftKey: true });
    expect(pressed("Pen")).toBe("true");
    expect(screen.getByRole("button", { name: "Pen style: Plain pen" })).toBeTruthy();
    expect(pressed("Colour: Blue")).toBe("true");
    // S arms the select tool; a click picks the stored box on page 1.
    fireEvent.keyDown(scroll, { key: "s" });
    expect(pressed("Select")).toBe("true");
    const layer = container.querySelector(".file-viewer-pdf-markup-layer") as HTMLDivElement;
    layer.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 800, right: 600, bottom: 800, x: 0, y: 0, toJSON() {} }) as DOMRect;
    fireEvent.pointerDown(layer, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 30, clientY: 20 });
    fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "mouse", clientX: 30, clientY: 20 });
    expect(await screen.findByText("1 selected")).toBeTruthy();
    // Escape lets the selection go first, and markup stays on.
    fireEvent.keyDown(scroll, { key: "Escape" });
    expect(screen.queryByText("1 selected")).toBeNull();
    expect(container.querySelectorAll(".file-viewer-pdf-markup-layer").length).toBe(2);
    // Delete deletes a selection.
    fireEvent.pointerDown(layer, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 30, clientY: 20 });
    fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "mouse", clientX: 30, clientY: 20 });
    expect(await screen.findByText("1 selected")).toBeTruthy();
    fireEvent.keyDown(scroll, { key: "Delete" });
    expect(screen.queryByText("1 selected")).toBeNull();
    const bar = within(container.querySelector(".file-viewer-pdf-markup-bar") as HTMLElement);
    expect((bar.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(false);
    localStorage.clear();
  });

  it("is held back on a document with unsaved edits", async () => {
    render(viewer());
    await loaded();
    await waitFor(() => expect(markUp()!.disabled).toBe(false));
    // A pending metadata deletion is an unsaved edit like any page change.
    fireEvent.click(screen.getByRole("button", { name: "Metadata" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete all metadata" }));
    await waitFor(() => expect(markUp()!.disabled).toBe(true));
    expect(markUp()!.title).toBe("Mark up works on the PDF as saved — save or undo the page edits first");
  });

  it("lets only one pane mark the same file", async () => {
    render(<>{viewer()}{viewer()}</>);
    await waitFor(() => expect(document.querySelectorAll(".file-viewer-pdf-page-wrap").length).toBe(4));
    const buttons = () => screen.getAllByRole("button", { name: /Mark up/ }) as HTMLButtonElement[];
    await waitFor(() => expect(buttons().every((button) => !button.disabled)).toBe(true));
    fireEvent.click(buttons()[0]);
    await waitFor(() => expect(buttons()[1].disabled).toBe(true));
    expect(buttons()[1].title).toBe("This PDF is being marked up in another pane");
  });
});

describe("a new version of the PDF while marking", () => {
  /** Markup on, the stored marks drawn, the reads so far counted. */
  async function marking() {
    const view = render(viewer());
    await loaded();
    await waitFor(() => expect(markUp()!.disabled).toBe(false));
    fireEvent.click(markUp()!);
    await waitFor(() => expect(io.loadLayer).toHaveBeenCalled());
    return view;
  }
  const reloadOffered = () => screen.findByText("The PDF changed on disk — Reload to see it under your marks.", undefined, { timeout: 5_000 });
  /** Settings → PDF markup: reload under the marks by hand only. */
  const byHand = () => useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, pdf_markup_auto_reload: false } as Settings });
  afterEach(() => useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, pdf_markup_auto_reload: undefined } as Settings }));

  it.each([
    ["the mtime poll", () => { io.mtime = 2_000; }],
    ["a compile's re-read request", () => usePdfSyncStore.getState().applyReload(PATH)],
    ["a SyncTeX reveal", () => usePdfSyncStore.getState().applyReveal(PATH, { page: 1, x: 10, y: 10, w: 10, h: 10 }, undefined, true)],
  ])("loads the new pages under the marks on its own by default — %s", async (_name, change) => {
    const { container } = await marking();
    const before = io.reads;
    act(() => change());
    await waitFor(() => expect(io.reads).toBe(before + 1), { timeout: 5_000 });
    expect(container.querySelectorAll(".file-viewer-pdf-markup-layer").length).toBe(2);
    expect(screen.queryByText("The PDF changed on disk — Reload to see it under your marks.")).toBeNull();
    // The strip says the new pages came by themselves.
    expect(await screen.findByText(/The PDF changed on disk and was reloaded under your marks\./)).toBeTruthy();
  });

  it("from the mtime poll, with auto-reload off: offers Reload, and Reload reads the file", async () => {
    byHand();
    await marking();
    const before = io.reads;
    io.mtime = 2_000;
    await reloadOffered();
    expect(io.reads).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: "Reload PDF" }));
    await waitFor(() => expect(io.reads).toBe(before + 1));
    // A reload by hand needs no note.
    expect(screen.queryByText(/was reloaded under your marks/)).toBeNull();
  });

  it("from a compile's re-read request, with auto-reload off", async () => {
    byHand();
    await marking();
    const before = io.reads;
    act(() => usePdfSyncStore.getState().applyReload(PATH));
    await reloadOffered();
    expect(io.reads).toBe(before);
  });

  it("from a SyncTeX reveal after a compile, with auto-reload off", async () => {
    byHand();
    await marking();
    const before = io.reads;
    act(() => usePdfSyncStore.getState().applyReveal(PATH, { page: 1, x: 10, y: 10, w: 10, h: 10 }, undefined, true));
    await reloadOffered();
    expect(io.reads).toBe(before);
  });

  it.each([
    ["the mtime poll", () => { io.mtime = 2_000; }],
    ["a compile's re-read request", () => usePdfSyncStore.getState().applyReload(PATH)],
    ["a SyncTeX reveal", () => usePdfSyncStore.getState().applyReveal(PATH, { page: 1, x: 10, y: 10, w: 10, h: 10 }, undefined, true)],
  ])("still repaints on its own with markup off — %s", async (_name, change) => {
    render(viewer());
    await loaded();
    const before = io.reads;
    act(() => change());
    await waitFor(() => expect(io.reads).toBe(before + 1), { timeout: 5_000 });
  });
});
