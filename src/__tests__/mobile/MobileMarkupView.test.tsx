/**
 * The markup view's Submit (`MarkupView`): each marked page's layer goes up
 * through the inbox first, then the marks to `/markup`, and only the prompt
 * the desktop answers goes into the chat — a step that fails sends nothing
 * and keeps the layer; one that succeeds keeps the view open, the round's
 * marks kept as sent. A note dragged with the note tool moves. And the
 * viewer offers Mark up only where there is a chat to send to — on a PDF
 * switched on and off in the same view, by the pen without a tap, and opened
 * in the mode this phone chose. ⋯ Clear all marks is one undoable step, ↑ ↓
 * step from mark to mark, and an outbox copy of a project file opens that
 * file's own layer (`docs/mobile_markup_shared_layer_plan.md`).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_LAYER, addMark, type Layer } from "../../../mobile-web/src/markup/layer";

const store = vi.hoisted(() => ({
  loadLayer: vi.fn(),
  saveLayer: vi.fn(async () => true),
  clearLayer: vi.fn(async () => true),
  moveLayer: vi.fn(async () => true),
}));
vi.mock("../../../mobile-web/src/markup/store", async (original) => ({
  ...(await original<typeof import("../../../mobile-web/src/markup/store")>()),
  ...store,
}));
vi.mock("../../../mobile-web/src/markup/rasterize", async (original) => ({
  ...(await original<typeof import("../../../mobile-web/src/markup/rasterize")>()),
  layerPng: vi.fn(async () => new Blob(["layer"], { type: "image/png" })),
  composedPng: vi.fn(async () => new Blob(["composed"], { type: "image/png" })),
}));

import { MarkupView } from "../../../mobile-web/src/components/MarkupView";
import { DEFAULT_MARKUP_INSTRUCTION, readMarkupInstruction, writeMarkupInstruction } from "../../../mobile-web/src/markupInstruction";
import { writeMarkupOpen } from "../../../mobile-web/src/markupOpen";
import { OutboxViewer, type MarkupSend } from "../../../mobile-web/src/components/OutboxViewer";
import { NAMES, storageDashKey } from "../../lib/brand";

const PICTURE = { name: "20261001-120000-plot.png", original: "plot.png", kind: "image/png", size: 4_000, modified: 1_790_000_000 };
const LAYER = addMark(EMPTY_LAYER, 1, [800, 600], { kind: "ink", color: "red", width: 2, points: [[10, 10, 0.5], [40, 30, 0.5]] });

type Call = { url: string; method: string; body?: BodyInit | null };

function desktop(failUpload = false) {
  const calls: Call[] = [];
  let uploads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body });
    if (url.includes("/inbox?name=")) {
      if (failUpload) return new Response(JSON.stringify({ error: "inbox_full" }), { status: 507 });
      uploads += 1;
      const name = decodeURIComponent(url.split("name=")[1]);
      return new Response(JSON.stringify({ attachment: { name, reference: `${NAMES.inboxDir}/2026-${uploads}-${name}`, size: 6 } }), { status: 201 });
    }
    if (url.endsWith("/markup")) return new Response(JSON.stringify({ prompt: "Apply the changes I marked by hand on `plot.png`.", marked: null }), { status: 200 });
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  }));
  return calls;
}

function showPicture() {
  const image = screen.getByAltText("plot.png") as HTMLImageElement;
  Object.defineProperty(image, "naturalWidth", { value: 800 });
  Object.defineProperty(image, "naturalHeight", { value: 600 });
  fireEvent.load(image);
}

beforeEach(() => {
  localStorage.clear();
  store.loadLayer.mockResolvedValue({ layer: LAYER, fingerprint: { size: PICTURE.size, modified: PICTURE.modified }, saved: 1 });
  store.clearLayer.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MarkupView", () => {
  it("uploads the layer and the marked picture, then sends the desktop's prompt", async () => {
    const calls = desktop();
    const onSend = vi.fn((): MarkupSend => "sent");
    const onClose = vi.fn();
    store.saveLayer.mockClear();
    render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={onSend} onClose={onClose} />);
    showPicture();
    const submit = await screen.findByRole("button", { name: "Submit" }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Apply the changes I marked by hand on `plot.png`."));
    const posts = calls.filter((call) => call.method === "POST").map((call) => call.url);
    expect(posts).toEqual([
      "/api/v1/tabs/t1/inbox?name=plot-p1-layer.png",
      "/api/v1/tabs/t1/inbox?name=plot-marked.png",
      "/api/v1/tabs/t1/markup",
    ]);
    const body = JSON.parse(String(calls.find((call) => call.url.endsWith("/markup"))!.body));
    expect(body).toEqual({
      source: { outbox: PICTURE.name },
      pages: [{ n: 1, size: [800, 600], marks: LAYER.pages[1].marks, layer: `${NAMES.inboxDir}/2026-1-plot-p1-layer.png` }],
      picture: `${NAMES.inboxDir}/2026-2-plot-marked.png`,
    });
    // The view stays open; the marks are kept as sent, not cleared.
    await waitFor(() => {
      const calls = store.saveLayer.mock.calls as unknown as [string, Layer][];
      const saved = calls[calls.length - 1];
      expect(saved?.[0]).toBe("p1:outbox:20261001-120000-plot.png");
      expect(saved?.[1]).toEqual({ pages: {}, sent: { pages: LAYER.pages, rounds: 1 } });
    });
    expect(store.clearLayer).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("toolbar", { name: "Markup tools" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("sends the instruction worded in the phone's settings, and only once it differs from the default", async () => {
    writeMarkupInstruction(`  ${DEFAULT_MARKUP_INSTRUCTION}  `);
    expect(readMarkupInstruction()).toBeNull();
    writeMarkupInstruction("Fix only the typos.\u0007\nAsk me first.");
    expect(readMarkupInstruction()).toBe("Fix only the typos.\nAsk me first.");
    const calls = desktop();
    const onSend = vi.fn((): MarkupSend => "sent");
    render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={onSend} onClose={() => {}} />);
    showPicture();
    const submit = await screen.findByRole("button", { name: "Submit" }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    const body = JSON.parse(String(calls.find((call) => call.url.endsWith("/markup"))!.body));
    expect(body.instruction).toBe("Fix only the typos.\nAsk me first.");
  });

  it("sends nothing and keeps the layer when an upload fails", async () => {
    const calls = desktop(true);
    const onSend = vi.fn((): MarkupSend => "sent");
    render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={onSend} onClose={() => {}} />);
    showPicture();
    const submit = await screen.findByRole("button", { name: "Submit" }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    expect(await screen.findByText(/page 1 could not be uploaded \(the project's inbox is full\)/)).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
    expect(calls.some((call) => call.url.endsWith("/markup"))).toBe(false);
    expect(store.clearLayer).not.toHaveBeenCalled();
  });

  it("moves a note dragged with the note tool, and Done leaves the markup", async () => {
    desktop();
    const note = { kind: "text" as const, color: "black" as const, at: [100, 100] as [number, number], size: 20, text: "hi" };
    store.loadLayer.mockResolvedValue({ layer: addMark(EMPTY_LAYER, 1, [800, 600], note), fingerprint: { size: PICTURE.size, modified: PICTURE.modified }, saved: 1 });
    store.saveLayer.mockClear();
    const onClose = vi.fn();
    const { container } = render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={() => "sent"} onClose={onClose} />);
    showPicture();
    await waitFor(() => expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Text note" }));
    // The page is 336 CSS pixels wide here: 800 / 336 page units a pixel.
    const px = (units: number) => units * 336 / 800;
    const canvas = container.querySelector(".markup-page-layer")!;
    fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: "mouse", clientX: px(110), clientY: px(110) });
    fireEvent.pointerMove(canvas, { pointerId: 1, pointerType: "mouse", clientX: px(210), clientY: px(160) });
    fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: "mouse", clientX: px(210), clientY: px(160) });
    await waitFor(() => {
      const calls = store.saveLayer.mock.calls as unknown as [string, Layer][];
      const saved = calls[calls.length - 1];
      expect(saved?.[1].pages[1].marks).toEqual([{ ...note, at: [200, 150] }]);
    });
    // A drag is not a tap: no note editor opened.
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clears every page from ⋯ in one step that Undo brings back", async () => {
    desktop();
    const both = addMark(LAYER, 2, [800, 600], { kind: "box", color: "yellow", rect: [5, 5, 50, 10] });
    store.loadLayer.mockResolvedValue({ layer: both, fingerprint: { size: PICTURE.size, modified: PICTURE.modified }, saved: 1 });
    store.saveLayer.mockClear();
    render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={() => "sent"} onClose={() => {}} />);
    showPicture();
    await waitFor(() => expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(false));
    const lastSaved = () => {
      const calls = store.saveLayer.mock.calls as unknown as [string, Layer][];
      return calls[calls.length - 1]?.[1];
    };
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("button", { name: /Clear all marks/ }));
    // The menu closes; every page is empty, saved as such.
    expect(screen.queryByRole("button", { name: /Clear all marks/ })).toBeNull();
    await waitFor(() => expect(lastSaved()?.pages).toEqual({}));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect((screen.getByRole("button", { name: /Clear all marks/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(lastSaved()).toEqual(both));
  });

  it("steps from mark to mark down and up a PDF's pages", async () => {
    const PDF = { name: "paper.pdf", kind: "application/pdf", size: 9_000, modified: 1_790_000_000 };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 })));
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
    // Two tall pages (600 × 1800): 336 CSS pixels wide here, 1008 high, the
    // second from 1020. A stroke low on page 1, a box high on page 2.
    let layer = addMark(EMPTY_LAYER, 1, [600, 1800], { kind: "ink", color: "red", width: 2, points: [[10, 900, 0.5], [40, 950, 0.5]] });
    layer = addMark(layer, 2, [600, 1800], { kind: "box", color: "yellow", rect: [5, 300, 50, 10] });
    store.loadLayer.mockResolvedValue({ layer, fingerprint: { size: PDF.size, modified: PDF.modified }, saved: 1 });
    const { container } = render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PDF} onSend={() => "sent"} onClose={() => {}} reader={{ actions: null }} />);
    const frame = (container.querySelector("iframe.markup-frame") as HTMLIFrameElement).contentWindow!;
    const say = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, origin: "null", source: frame }));
    vi.spyOn(frame, "postMessage").mockImplementation(() => {});
    act(() => { say({ type: "ready" }); say({ type: "meta", pages: [{ w: 600, h: 1800 }, { w: 600, h: 1800 }] }); });
    const previous = await screen.findByRole("button", { name: "Previous mark" }) as HTMLButtonElement;
    const next = screen.getByRole("button", { name: "Next mark" }) as HTMLButtonElement;
    const scroller = container.querySelector(".markup-scroller") as HTMLDivElement;
    const scrollAt = (top: number) => {
      Object.defineProperty(scroller, "scrollTop", { configurable: true, writable: true, value: top });
      fireEvent.scroll(scroller);
    };
    // Each mark goes to a third of the way down the 640 pixel view.
    const first = 900 * 336 / 600 - 640 / 3;
    const second = 1020 + 300 * 336 / 600 - 640 / 3;
    expect(previous.disabled).toBe(true);
    fireEvent.click(next);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: first });
    scrollAt(first);
    expect(previous.disabled).toBe(true);
    fireEvent.click(next);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: second });
    scrollAt(second);
    expect(next.disabled).toBe(true);
    fireEvent.click(previous);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: first });
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  });

  it("keeps Submit off while nothing is marked", async () => {
    desktop();
    store.loadLayer.mockResolvedValue(null);
    render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={() => "sent"} onClose={() => {}} />);
    showPicture();
    await waitFor(() => expect(store.loadLayer).toHaveBeenCalled());
    expect((screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("OutboxViewer · Mark up", () => {
  const PDF = { name: "paper.pdf", kind: "application/pdf", size: 9_000, modified: 1_790_000_000 };
  const TEXT = { name: "notes.md", kind: "text/plain; charset=utf-8", size: 9, modified: 1_790_000_000 };

  it("offers Mark up on a PDF or picture only where a chat can take it", () => {
    desktop();
    const markup = { tabId: "t1", projectId: "p1", onSend: (): MarkupSend => "sent" };
    const { rerender } = render(<OutboxViewer scope={{ tab: "t1" }} file={PDF} onClose={() => {}} markup={markup} />);
    expect(screen.getByRole("button", { name: "Mark up paper.pdf" })).toBeTruthy();
    rerender(<OutboxViewer scope={{ tab: "t1" }} file={PDF} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: "Mark up paper.pdf" })).toBeNull();
    rerender(<OutboxViewer scope={{ tab: "t1" }} file={TEXT} onClose={() => {}} markup={markup} />);
    expect(screen.queryByRole("button", { name: /Mark up/ })).toBeNull();
  });

  it("switches a PDF's markup on and off in the same view", async () => {
    desktop();
    writeMarkupOpen("reading");
    store.loadLayer.mockResolvedValue({ layer: LAYER, fingerprint: { size: PDF.size, modified: PDF.modified }, saved: 1 });
    const onClose = vi.fn();
    render(<OutboxViewer scope={{ tab: "t1" }} file={PDF} onClose={onClose} markup={{ tabId: "t1", projectId: "p1", onSend: (): MarkupSend => "sent" }} />);
    const view = screen.getByRole("dialog");
    expect(screen.queryByRole("toolbar")).toBeNull();
    // The marks already made are loaded to be on show, and Mark up says so.
    await waitFor(() => expect(screen.getByRole("button", { name: "Mark up paper.pdf" }).classList.contains("has-marks")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Mark up paper.pdf" }));
    expect(screen.getByRole("toolbar", { name: "Markup tools" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Save" })).toBeNull();
    // The same view, not a second one: the pages and their place stay.
    expect(screen.getByRole("dialog")).toBe(view);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.getByRole("link", { name: "Save" })).toBeTruthy();
    expect(screen.getByRole("dialog")).toBe(view);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("opens an outbox copy's project file, with its layer, and moves the copy's marks over once", async () => {
    const calls = desktop();
    writeMarkupOpen("reading");
    const copy = { name: "20261004-120000-paper.pdf", original: "paper.pdf", kind: "application/pdf", size: 9_000, modified: 1_790_000_000,
      file_row: { token: "sealed-file", name: "paper.pdf", kind: "application/pdf", size: 9_000, modified: 1_780_000_000, folder: "sealed-folder", place: "docs" } };
    const filesKey = "p1:files:docs/paper.pdf";
    const copyKey = "p1:outbox:20261004-120000-paper.pdf";
    store.loadLayer.mockImplementation(async (key: string) => (key === copyKey ? { layer: LAYER, fingerprint: { size: 9_000, modified: 1_790_000_000 }, saved: 1 } : null));
    store.moveLayer.mockClear();
    store.saveLayer.mockClear();
    const markup = { tabId: "t1", projectId: "p1", onSend: (): MarkupSend => "sent" };
    render(<OutboxViewer scope={{ tab: "t1" }} file={copy} onClose={() => {}} markup={markup} />);
    // The project file's bytes, through the drawer's door — not the copy's.
    await waitFor(() => expect(calls.some((call) => call.url === "/api/v1/projects/p1/files/raw?f=sealed-file")).toBe(true));
    expect(calls.some((call) => call.url.includes("/outbox/"))).toBe(false);
    // Same size: stamped with the project file, so it is not called changed.
    await waitFor(() => expect(store.moveLayer).toHaveBeenCalledWith(copyKey, filesKey, { size: 9_000, modified: 1_780_000_000 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Mark up paper.pdf" }).classList.contains("has-marks")).toBe(true));
    expect(screen.queryByText(/changed since/)).toBeNull();
    // Save still hands over the copy.
    expect(screen.getByRole("link", { name: "Save" }).getAttribute("href")).toBe("/api/v1/tabs/t1/outbox/20261004-120000-paper.pdf?download=1");
    cleanup();

    // The project file has marks of its own: they win, nothing is merged.
    store.loadLayer.mockImplementation(async () => ({ layer: LAYER, fingerprint: { size: 9_000, modified: 1_780_000_000 }, saved: 1 }));
    store.moveLayer.mockClear();
    render(<OutboxViewer scope={{ tab: "t1" }} file={copy} onClose={() => {}} markup={markup} />);
    await waitFor(() => expect(store.loadLayer).toHaveBeenCalledWith(filesKey));
    await waitFor(() => expect(screen.getByRole("button", { name: "Mark up paper.pdf" }).classList.contains("has-marks")).toBe(true));
    expect(store.moveLayer).not.toHaveBeenCalled();
    cleanup();

    // No project behind the tab: the copy as before.
    store.loadLayer.mockClear();
    render(<OutboxViewer scope={{ tab: "t1" }} file={copy} onClose={() => {}} markup={{ ...markup, projectId: "tab:t1" }} />);
    await waitFor(() => expect(store.loadLayer).toHaveBeenCalledWith("tab:t1:outbox:20261004-120000-paper.pdf"));
    store.loadLayer.mockReset();
  });

  it("draws a PDF inside the app, read only, with ✕ closing back to it", () => {
    desktop();
    store.loadLayer.mockClear();
    store.saveLayer.mockClear();
    const onClose = vi.fn();
    render(<OutboxViewer scope={{ tab: "t1" }} file={PDF} onClose={onClose} />);
    // The pages come from the sealed frame, not the phone's own PDF viewer.
    expect(screen.getByTitle("pdf").getAttribute("src")).toBe("/pdf-frame.html");
    expect(screen.queryByRole("button", { name: /Open paper\.pdf/ })).toBeNull();
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.getByRole("link", { name: "Save" })).toBeTruthy();
    expect(store.loadLayer).not.toHaveBeenCalled();
    expect(store.saveLayer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("MarkupView · reading", () => {
  const reader = { actions: null };
  const renderReader = () => render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={() => "sent"} onClose={() => {}} reader={reader} />);

  it("lets the pen switch the markup on and keeps the stroke it began", async () => {
    desktop();
    store.loadLayer.mockResolvedValue(null);
    store.saveLayer.mockClear();
    const { container } = renderReader();
    showPicture();
    await waitFor(() => expect(store.loadLayer).toHaveBeenCalled());
    const canvas = container.querySelector(".markup-page-layer")!;
    await waitFor(() => expect(screen.getByRole("button", { name: /^Mark up/ })).toBeTruthy());
    // A finger reads: it scrolls and draws nothing.
    expect(fireEvent.touchStart(canvas, { touches: [{}], changedTouches: [{}] })).toBe(true);
    fireEvent.pointerDown(canvas, { pointerId: 1, pointerType: "touch", clientX: 20, clientY: 20 });
    fireEvent.pointerUp(canvas, { pointerId: 1, pointerType: "touch", clientX: 20, clientY: 20 });
    expect(screen.queryByRole("toolbar")).toBeNull();
    // The pen on a page does not scroll it: it marks.
    expect(fireEvent.touchStart(canvas, { touches: [{ touchType: "stylus" }], changedTouches: [{ touchType: "stylus" }] })).toBe(false);
    fireEvent.pointerDown(canvas, { pointerId: 2, pointerType: "pen", pressure: 0.5, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(canvas, { pointerId: 2, pointerType: "pen", pressure: 0.5, clientX: 60, clientY: 40 });
    fireEvent.pointerUp(canvas, { pointerId: 2, pointerType: "pen", pressure: 0.5, clientX: 60, clientY: 40 });
    expect(screen.getByRole("toolbar", { name: "Markup tools" })).toBeTruthy();
    await waitFor(() => {
      const calls = store.saveLayer.mock.calls as unknown as [string, Layer][];
      const marks = calls[calls.length - 1]?.[1].pages[1]?.marks ?? [];
      expect(marks.map((mark) => mark.kind)).toEqual(["ink"]);
    });
    // The first pen here leaves fingers to scroll.
    expect(localStorage.getItem(storageDashKey("markup-pen"))).toBe("1");
  });

  it("opens reading, or marking when this phone asks for it", async () => {
    desktop();
    store.loadLayer.mockResolvedValue(null);
    renderReader();
    showPicture();
    await waitFor(() => expect(store.loadLayer).toHaveBeenCalled());
    expect(screen.queryByRole("toolbar")).toBeNull();
    cleanup();
    writeMarkupOpen("markup");
    renderReader();
    expect(screen.getByRole("toolbar", { name: "Markup tools" })).toBeTruthy();
  });

  it("opens marking on Automatic once only the pen draws here", () => {
    desktop();
    store.loadLayer.mockResolvedValue(null);
    localStorage.setItem(storageDashKey("markup-pen"), "1");
    renderReader();
    expect(screen.getByRole("toolbar", { name: "Markup tools" })).toBeTruthy();
  });

  it("opens marking on Automatic while marks wait to be submitted, and not on Reading", async () => {
    desktop();
    renderReader();
    await waitFor(() => expect(screen.getByRole("toolbar", { name: "Markup tools" })).toBeTruthy());
    cleanup();
    writeMarkupOpen("reading");
    renderReader();
    await waitFor(() => expect(screen.getByRole("button", { name: /^Mark up/ }).classList.contains("has-marks")).toBe(true));
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});
