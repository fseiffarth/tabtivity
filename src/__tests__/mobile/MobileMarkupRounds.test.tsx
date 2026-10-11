/**
 * Markup rounds on the phone (`docs/pdf_markup_rounds_plan.md` Phase A): a
 * Submit keeps the view and its layer, the next Submit sends only the marks
 * made since, a pill follows the agent, Reload draws the file anew — or the
 * agent's newer copy — under the same layer, and the chat's `sendMarkup`
 * closes nothing and says when the prompt went into a working agent's queue.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_LAYER, addMark, markSent, type Layer } from "../../../mobile-web/src/markup/layer";
import { SETTLE_MS } from "../../../mobile-web/src/markup/submitState";
import { DEFAULT_MARKUP_APPLY, MARKUP_SUBAGENT_LINE, markupForSubagent, markupUndoNote, readMarkupApply, writeMarkupApply } from "../../../mobile-web/src/markupInstruction";
import { writeFlag } from "../../../mobile-web/src/prefs";

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
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = { active: { type: "normal", length: 0, getLine: () => undefined } };
    loadAddon() {}
    open() {}
    write(_value: Uint8Array | string, callback?: () => void) { callback?.(); }
    onData() { return { dispose() {} }; }
    scrollLines() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { MarkupView } from "../../../mobile-web/src/components/MarkupView";
import type { OutboxFile } from "../../../mobile-web/src/api";
import type { MarkupSend } from "../../../mobile-web/src/components/OutboxViewer";
import type { AgentSignal } from "../../../mobile-web/src/markup/submitState";
import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { NAMES, storageKey } from "../../lib/brand";

const PICTURE = { name: "20261001-120000-plot.png", original: "plot.png", kind: "image/png", size: 4_000, modified: 1_790_000_000 };
const PDF = { name: "20261001-120000-paper.pdf", original: "paper.pdf", kind: "application/pdf", size: 9_000, modified: 1_790_000_000 };
const NEWER = { ...PDF, name: "20261002-090000-paper.pdf", size: 9_500, modified: 1_790_090_000, from_tab: true };
const LAYER = addMark(EMPTY_LAYER, 1, [800, 600], { kind: "ink", color: "red", width: 2, points: [[10, 10, 0.5], [40, 30, 0.5]] });

type Call = { url: string; method: string; body?: BodyInit | null };

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The sidecar: the inbox, `/markup`, a PDF's bytes, and `{}` for the rest. */
function desktop() {
  const calls: Call[] = [];
  let uploads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body });
    if (url.includes("/inbox?name=")) {
      uploads += 1;
      const name = decodeURIComponent(url.split("name=")[1]);
      return jsonResponse(201, { attachment: { name, reference: `${NAMES.inboxDir}/2026-${uploads}-${name}`, size: 6 } });
    }
    if (url.endsWith("/markup")) return jsonResponse(200, { prompt: `Round ${calls.filter((call) => call.url.endsWith("/markup")).length}`, marked: null });
    if (url.endsWith(".pdf")) return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 });
    if (url.endsWith("/outbox")) return jsonResponse(200, { files: [] });
    if (url.endsWith("/held")) return jsonResponse(201, { id: "held-1" });
    if (url.includes("/transcript")) return jsonResponse(200, { transcript: { available: true, version: "v1", truncated: false, entries: [] } });
    if (url.endsWith("/schedules")) return jsonResponse(200, { schedules: [], time_zone: "UTC", next_runs: {} });
    return jsonResponse(200, {});
  }));
  return calls;
}

function showPicture() {
  const image = screen.getByAltText("plot.png") as HTMLImageElement;
  Object.defineProperty(image, "naturalWidth", { value: 800 });
  Object.defineProperty(image, "naturalHeight", { value: 600 });
  fireEvent.load(image);
}

const markupBodies = (calls: Call[]) => calls.filter((call) => call.url.endsWith("/markup")).map((call) => JSON.parse(String(call.body)));
const submitButton = () => screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;

beforeEach(() => {
  localStorage.clear();
  store.loadLayer.mockReset();
  store.loadLayer.mockResolvedValue({ layer: LAYER, fingerprint: { size: PICTURE.size, modified: PICTURE.modified }, saved: 1 });
  store.saveLayer.mockClear();
  store.clearLayer.mockClear();
  store.moveLayer.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("MarkupView · rounds", () => {
  it("keeps the view and the layer after a Submit, and the next one carries only the new marks", async () => {
    const calls = desktop();
    const onSend = vi.fn((): MarkupSend => "sent");
    const onClose = vi.fn();
    const { container } = render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={onSend} onClose={onClose} />);
    showPicture();
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Round 1"));
    await waitFor(() => expect(submitButton().disabled).toBe(true));
    expect(onClose).not.toHaveBeenCalled();
    expect(store.clearLayer).not.toHaveBeenCalled();

    // Marking goes on: a highlighter box is the next round.
    fireEvent.click(screen.getByRole("button", { name: "Highlighter" }));
    const canvas = container.querySelector(".markup-page-layer")!;
    fireEvent.pointerDown(canvas, { pointerId: 2, pointerType: "mouse", clientX: 100, clientY: 100 });
    fireEvent.pointerMove(canvas, { pointerId: 2, pointerType: "mouse", clientX: 160, clientY: 140 });
    fireEvent.pointerUp(canvas, { pointerId: 2, pointerType: "mouse", clientX: 160, clientY: 140 });
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Round 2"));

    const [, second] = markupBodies(calls);
    expect(Object.keys(second).sort()).toEqual(["mode", "pages", "picture", "round", "source"]);
    // Apply marks directly is on unset: each Submit asks for an apply round.
    expect(second.mode).toBe("apply");
    expect(second.pages).toHaveLength(1);
    expect(Object.keys(second.pages[0]).sort()).toEqual(["layer", "marks", "n", "size"]);
    expect(second.pages[0].marks).toHaveLength(1);
    expect(second.pages[0].marks[0]).toMatchObject({ kind: "box", color: "yellow" });
    expect(Object.keys(second.pages[0].marks[0]).sort()).toEqual(["color", "kind", "rect"]);
    // Both rounds are kept as sent, the second's box after the first's stroke.
    await waitFor(() => {
      const saves = store.saveLayer.mock.calls as unknown as [string, Layer][];
      const saved = saves[saves.length - 1][1];
      expect(saved.pages).toEqual({});
      expect(saved.sent?.rounds).toBe(2);
      expect(saved.sent?.pages[1].marks.map((mark) => mark.kind)).toEqual(["ink", "box"]);
    });
  });

  it("hands each Submit to a new subagent once ⋯ switches subagent mode on, and remembers it", async () => {
    const calls = desktop();
    const onSend = vi.fn((): MarkupSend => "sent");
    render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={onSend} onClose={() => {}} />);
    showPicture();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const toggle = screen.getByRole("switch", { name: /Each Submit to a new subagent/ });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem(storageKey("mobile.markupSubagents"))).toBe("1");
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(markupForSubagent("Round 1")));
    expect(markupForSubagent("Round 1").startsWith(`${MARKUP_SUBAGENT_LINE}\n\n`)).toBe(true);
    // The wrapper is the viewer's: the desktop's request is unchanged.
    expect(Object.keys(markupBodies(calls)[0]).sort()).toEqual(["mode", "pages", "picture", "round", "source"]);
  });

  it("shows what the agent does with the round, in a pill that follows it", async () => {
    desktop();
    const onSend = vi.fn((): MarkupSend => "queued");
    const view = (agent: AgentSignal) => <MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={onSend} agent={agent} onClose={() => {}} />;
    const { rerender } = render(view("working"));
    showPicture();
    // Over marks never sent, no pill: there is no round to follow.
    expect(screen.queryByText("Agent is working…")).toBeNull();
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    // The first look already sees the agent at work.
    expect(await screen.findByText("Agent is working…")).toBeTruthy();
    rerender(view("question"));
    expect(screen.getByText("The agent is asking something — answer in the chat")).toBeTruthy();
    vi.useFakeTimers();
    rerender(view("idle"));
    await act(async () => { vi.advanceTimersByTime(SETTLE_MS - 100); });
    expect(screen.queryByText("Agent finished")).toBeNull();
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(screen.getByText("Agent finished")).toBeTruthy();
    // A picture has no Reload: its marks are the reply's own.
    expect(screen.queryByRole("button", { name: "Reload PDF" })).toBeNull();
    rerender(view("working"));
    expect(screen.getByText("Agent is working…")).toBeTruthy();
    // With the tab's model known, the pill names it.
    rerender(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={onSend} agent="working" model="Opus" onClose={() => {}} />);
    expect(screen.getByText("Opus is working…")).toBeTruthy();
  });

  it("offers Make these changes once the agent listed them, and sends the phone's own wording once", async () => {
    desktop();
    writeMarkupApply("Go ahead with all of them.");
    const onSend = vi.fn((): MarkupSend => "sent");
    const view = (agent: AgentSignal) => <MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={onSend} agent={agent} onClose={() => {}} />;
    const { rerender } = render(view("idle"));
    showPicture();
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Round 1"));
    // Not before the agent is done with the marks.
    expect(screen.queryByRole("button", { name: /Make these changes/ })).toBeNull();
    rerender(view("working"));
    vi.useFakeTimers();
    rerender(view("idle"));
    await act(async () => { vi.advanceTimersByTime(SETTLE_MS); });
    fireEvent.click(screen.getByRole("button", { name: /Make these changes/ }));
    expect(onSend).toHaveBeenLastCalledWith("Go ahead with all of them.");
    expect(screen.getByText("Sent — waiting for the agent")).toBeTruthy();
    // The follow-up's own turn: no second offer once it is done.
    rerender(view("working"));
    rerender(view("idle"));
    await act(async () => { vi.advanceTimersByTime(SETTLE_MS); });
    expect(screen.getByText("Agent finished")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Make these changes/ })).toBeNull();
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it("sends the default Make these changes prompt while the phone keeps none of its own", () => {
    expect(readMarkupApply()).toBeNull();
    writeMarkupApply(`  ${DEFAULT_MARKUP_APPLY} `);
    expect(readMarkupApply()).toBeNull();
    writeMarkupApply("Do it\u0007 now");
    expect(readMarkupApply()).toBe("Do it now");
    writeMarkupApply("");
    expect(readMarkupApply()).toBeNull();
  });

  it("asks the sealed frame for each page's picture and words, and sends the words with the marks", async () => {
    const calls = desktop();
    store.loadLayer.mockResolvedValue({ layer: LAYER, fingerprint: { size: PDF.size, modified: PDF.modified }, saved: 1 });
    const { container } = render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PDF} onSend={() => "sent"} onClose={() => {}} />);
    const frame = (container.querySelector("iframe.markup-frame") as HTMLIFrameElement).contentWindow!;
    const say = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, origin: "null", source: frame }));
    const asked: string[] = [];
    vi.spyOn(frame, "postMessage").mockImplementation((message: unknown) => {
      const ask = message as { type: string; id: number; n?: number; page?: number };
      asked.push(ask.type);
      // No ImageBitmap here: the picture fails, and the marks go alone.
      if (ask.type === "snapshot") queueMicrotask(() => say({ type: "snapshot", id: ask.id, n: ask.n }));
      if (ask.type === "text") queueMicrotask(() => say({ type: "text", id: ask.id, page: ask.page, runs: [{ str: "Hello world", x: 5, y: 8, w: 66, h: 12 }] }));
    });
    // The bytes arrive, then the frame says it is up and what the pages are.
    await waitFor(() => expect(calls.some((call) => call.url.endsWith(".pdf"))).toBe(true));
    act(() => { say({ type: "ready" }); say({ type: "meta", pages: [{ w: 800, h: 600 }] }); });
    await waitFor(() => expect(asked).toContain("open"));
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    expect(await screen.findByText("Sent — waiting for the agent")).toBeTruthy();
    expect(asked).toEqual(expect.arrayContaining(["snapshot", "text"]));
    expect(calls.some((call) => call.url.includes("name=paper-p1-layer.png"))).toBe(true);
    expect(markupBodies(calls)[0].pages).toEqual([{
      n: 1, size: [800, 600], marks: LAYER.pages[1].marks, layer: `${NAMES.inboxDir}/2026-1-paper-p1-layer.png`,
      anchors: [{ mark: 0, how: "on", words: "Hello", line: "Hello world" }],
    }]);
  });

  it("loads the changed PDF under the marks once the agent finished, by default", async () => {
    desktop();
    store.loadLayer.mockResolvedValue({ layer: LAYER, fingerprint: { size: PDF.size, modified: PDF.modified }, saved: 1 });
    const refresh = vi.fn(async () => NEWER);
    const view = (agent: AgentSignal) => <MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PDF} onSend={() => "sent"} agent={agent} refresh={refresh} onClose={() => {}} />;
    const { rerender } = render(view("idle"));
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    expect(await screen.findByText("Sent — waiting for the agent")).toBeTruthy();
    rerender(view("working"));
    vi.useFakeTimers();
    rerender(view("idle"));
    await act(async () => { vi.advanceTimersByTime(SETTLE_MS); });
    // The look, then the reload it led to — no tap.
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(screen.getByText("The agent's new PDF is loaded under your marks.")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Reload PDF" }).some((button) => button.classList.contains("markup-submit"))).toBe(false);
  });

  it("looks at the PDF once the agent finished, and offers Reload by what it found, with auto-reload off", async () => {
    writeFlag("markupAutoReload", false);
    desktop();
    store.loadLayer.mockResolvedValue({ layer: LAYER, fingerprint: { size: PDF.size, modified: PDF.modified }, saved: 1 });
    const refresh = vi.fn(async () => NEWER);
    const view = (agent: AgentSignal) => <MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PDF} onSend={() => "sent"} agent={agent} refresh={refresh} onClose={() => {}} />;
    const { rerender } = render(view("idle"));
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    expect(await screen.findByText("Sent — waiting for the agent")).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
    rerender(view("working"));
    vi.useFakeTimers();
    rerender(view("idle"));
    await act(async () => { vi.advanceTimersByTime(SETTLE_MS); });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Agent finished — PDF changed")).toBeTruthy();
    const reload = screen.getAllByRole("button", { name: "Reload PDF" }).find((button) => button.classList.contains("markup-submit"));
    expect(reload).toBeTruthy();
  });

  it("offers no Reload once the look found the PDF unchanged", async () => {
    desktop();
    store.loadLayer.mockResolvedValue({ layer: LAYER, fingerprint: { size: PDF.size, modified: PDF.modified }, saved: 1 });
    const refresh = vi.fn(async (file: OutboxFile) => file);
    const view = (agent: AgentSignal) => <MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PDF} onSend={() => "sent"} agent={agent} refresh={refresh} onClose={() => {}} />;
    const { rerender } = render(view("idle"));
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    expect(await screen.findByText("Sent — waiting for the agent")).toBeTruthy();
    rerender(view("working"));
    vi.useFakeTimers();
    rerender(view("idle"));
    await act(async () => { vi.advanceTimersByTime(SETTLE_MS); });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Agent finished — PDF unchanged")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reload PDF" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("button", { name: /Reload PDF/ })).toBeNull();
  });

  it("says Queued while the agent works on its current step", async () => {
    desktop();
    render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={() => "queued"} onClose={() => {}} />);
    showPicture();
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    expect(await screen.findByText("Queued — the agent takes it after its current step")).toBeTruthy();
  });

  it("offers Chat once a round is out, which tucks the view away under the file's name", async () => {
    desktop();
    const toChat = vi.fn();
    const onClose = vi.fn();
    render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={() => "queued"} toChat={toChat} onClose={onClose} />);
    showPicture();
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    expect(screen.queryByRole("button", { name: /^Chat/ })).toBeNull();
    fireEvent.click(submitButton());
    fireEvent.click(await screen.findByRole("button", { name: /^Chat/ }));
    expect(toChat).toHaveBeenCalledWith("plot.png");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows a dialog the tab waits on and makes Answer in chat lead while it waits", async () => {
    desktop();
    const toChat = vi.fn();
    const view = (agent: AgentSignal, dialog?: string) => <MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE}
      onSend={() => "queued"} agent={agent} dialog={dialog} toChat={toChat} onClose={() => {}} />;
    const { rerender } = render(view("idle"));
    showPicture();
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    expect(await screen.findByRole("button", { name: /^Chat/ })).toBeTruthy();
    rerender(view("question", "Do you want to make this edit to main.tex?"));
    expect(screen.getByText("“Do you want to make this edit to main.tex?”")).toBeTruthy();
    const answer = screen.getByRole("button", { name: /^Answer in chat/ });
    expect(answer.className).toContain("markup-submit");
    fireEvent.click(answer);
    expect(toChat).toHaveBeenCalledWith("plot.png");
    // Answered: back to the plain Chat button, no line.
    rerender(view("working"));
    expect(screen.queryByText("“Do you want to make this edit to main.tex?”")).toBeNull();
    expect(screen.getByRole("button", { name: /^Chat/ }).className).toContain("outbox-action");
  });

  it("reloads the agent's newer copy under the same layer, with no 'changed' note", async () => {
    const calls = desktop();
    const sent = markSent(LAYER);
    store.loadLayer.mockResolvedValue({ layer: addMark(sent, 1, [800, 600], { kind: "box", color: "yellow", rect: [1, 1, 20, 20] }), fingerprint: { size: PDF.size, modified: PDF.modified }, saved: 1 });
    const refresh = vi.fn(async () => NEWER);
    render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PDF} onSend={() => "sent"} refresh={refresh} onClose={() => {}} />);
    await waitFor(() => expect(store.loadLayer).toHaveBeenCalledTimes(1));
    const frame = screen.getByTitle("pdf");
    await waitFor(() => expect(calls.some((call) => call.url.endsWith(`/outbox/${PDF.name}`))).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("switch", { name: "Show sent marks" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Reload PDF/ }));

    await waitFor(() => expect(store.moveLayer).toHaveBeenCalledWith(
      `p1:outbox:${PDF.name}`, `p1:outbox:${NEWER.name}`, { size: NEWER.size, modified: NEWER.modified },
    ));
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ name: PDF.name }));
    // A new frame for the new bytes; the layer is not read back over itself.
    await waitFor(() => expect(screen.getByTitle("pdf")).not.toBe(frame));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith(`/outbox/${NEWER.name}`))).toBe(true));
    expect(store.loadLayer).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("This file changed since you marked it.")).toBeNull();
    await waitFor(() => {
      const saves = store.saveLayer.mock.calls as unknown as [string, Layer, { size: number; modified: number }][];
      const saved = saves[saves.length - 1];
      expect(saved[0]).toBe(`p1:outbox:${NEWER.name}`);
      expect(saved[2]).toEqual({ size: NEWER.size, modified: NEWER.modified });
      // The unsent box is still there to send, and the sent marks too.
      expect(saved[1].pages[1].marks).toHaveLength(1);
      expect(saved[1].sent?.pages[1].marks.length).toBeGreaterThan(0);
    });
    // The sent marks stay on show to check the changes against; only the
    // reader erases or hides them.
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("switch", { name: "Show sent marks" }).getAttribute("aria-checked")).toBe("true");
  });

  it("says when there was no newer copy to reload", async () => {
    desktop();
    store.loadLayer.mockResolvedValue({ layer: markSent(LAYER), fingerprint: { size: PDF.size, modified: PDF.modified }, saved: 1 });
    render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PDF} onSend={() => "sent"} refresh={async (file) => file} onClose={() => {}} />);
    await waitFor(() => expect(store.loadLayer).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("button", { name: /Reload PDF/ }));
    expect(await screen.findByText("No new version sent yet — reloaded the one shown.")).toBeTruthy();
    expect(store.moveLayer).not.toHaveBeenCalled();
  });
});

describe("MarkupView · apply rounds and Undo", () => {
  const UNDO_ID = "0123456789abcdef0123456789abcdef";
  type Undo = { submit?: Record<string, unknown>; preview?: [number, unknown]; undo?: [number, unknown] };

  /** The sidecar of `desktop()`, with `/markup` answering an apply round
   * (or `submit`) and the undo routes answering `preview` / `undo`. */
  function undoDesktop(answers: Undo = {}) {
    const calls = desktop();
    const inner = globalThis.fetch as unknown as (input: string, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/markup")) {
        calls.push({ url, method, body: init?.body });
        return Promise.resolve(jsonResponse(200, answers.submit ?? { prompt: "Round 1", marked: null, mode: "apply", undo: UNDO_ID, noUndo: null }));
      }
      if (url.includes("/markup/undo/")) {
        calls.push({ url, method, body: init?.body });
        if (url.endsWith("/settle")) return Promise.resolve(jsonResponse(200, {}));
        const [status, body] = method === "GET"
          ? answers.preview ?? [200, { files: [{ path: "paper.tex", change: "modified" }], more: 0, pdf: "restored" }]
          : answers.undo ?? [200, { files: [{ path: "paper.tex", change: "modified" }], more: 0, pdf: "restored" }];
        return Promise.resolve(jsonResponse(status, body));
      }
      return inner(input, init);
    }));
    return calls;
  }
  const undoCalls = (calls: Call[], what: "settle" | "preview" | "undo") => calls.filter((call) => call.url.includes(`/markup/undo/${UNDO_ID}`)
    && (what === "settle" ? call.url.endsWith("/settle") : !call.url.endsWith("/settle") && call.method === (what === "preview" ? "GET" : "POST")));
  const undoButton = () => screen.queryByRole("button", { name: "Undo the agent's changes from this round" });

  /** A PDF view, Submitted, through one turn of the agent to finished. */
  async function finishedRound(calls: Call[], onSend: (text: string) => MarkupSend, refresh = vi.fn(async (file: OutboxFile) => file)) {
    writeFlag("markupAutoReload", false);
    store.loadLayer.mockResolvedValue({ layer: LAYER, fingerprint: { size: PDF.size, modified: PDF.modified }, saved: 1 });
    const view = (agent: AgentSignal) => <MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PDF} onSend={onSend} agent={agent} refresh={refresh} onClose={() => {}} />;
    const { rerender } = render(view("idle"));
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    expect(await screen.findByText("Sent — waiting for the agent")).toBeTruthy();
    expect(markupBodies(calls)[0].mode).toBe("apply");
    // Not before the agent is done with the marks.
    expect(undoButton()).toBeNull();
    rerender(view("working"));
    expect(undoButton()).toBeNull();
    vi.useFakeTimers();
    rerender(view("idle"));
    await act(async () => { vi.advanceTimersByTime(SETTLE_MS); });
    vi.useRealTimers();
    expect(screen.getByText(/^Agent finished/)).toBeTruthy();
    return { refresh, rerender, view };
  }

  it("settles the round as it finishes, offers Undo, and after the sheet's Undo reloads and tells the agent — no new round", async () => {
    const calls = undoDesktop();
    const onSend = vi.fn((): MarkupSend => "sent");
    const { refresh } = await finishedRound(calls, onSend);
    await waitFor(() => expect(undoCalls(calls, "settle")).toHaveLength(1));
    expect(undoCalls(calls, "settle")[0].method).toBe("POST");
    expect(undoCalls(calls, "settle")[0].url).toBe(`/api/v1/tabs/t1/markup/undo/${UNDO_ID}/settle`);
    // An apply round: Undo, never Make these changes.
    expect(screen.queryByRole("button", { name: /Make these changes/ })).toBeNull();
    const looks = refresh.mock.calls.length;
    fireEvent.click(undoButton()!);
    const sheet = await screen.findByRole("dialog", { name: "Undo the agent's changes from these marks?" });
    expect(within(sheet).getByText("Back as before: paper.tex. The PDF goes back to before.")).toBeTruthy();
    expect(undoCalls(calls, "undo")).toHaveLength(0);
    fireEvent.click(within(sheet).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(undoCalls(calls, "undo")).toHaveLength(1));
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith(markupUndoNote(["paper.tex"], 0)));
    expect(await screen.findByText("Undone — the files are back as they were before the round.")).toBeTruthy();
    // The PDF is drawn again (the Reload path), the round is not restarted,
    // and the Undo is offered no more.
    await waitFor(() => expect(refresh.mock.calls.length).toBe(looks + 1));
    expect(screen.queryByText("Sent — waiting for the agent")).toBeNull();
    expect(screen.getByText(/^Agent finished/)).toBeTruthy();
    expect(undoButton()).toBeNull();
    expect(screen.queryByRole("button", { name: /Make these changes/ })).toBeNull();
    expect(onSend).toHaveBeenCalledTimes(2);
    // The sent marks stay.
    const saves = store.saveLayer.mock.calls as unknown as [string, Layer][];
    expect(saves[saves.length - 1][1].sent?.pages[1].marks.length).toBeGreaterThan(0);
  });

  it("puts an outbox view back on the copy the marks were drawn on, and passes over the agent's undone copies after", async () => {
    const calls = undoDesktop();
    store.loadLayer.mockResolvedValue({ layer: LAYER, fingerprint: { size: PDF.size, modified: PDF.modified }, saved: 1 });
    // The agent's rebuilt copy stays the newest this tab sent.
    const refresh = vi.fn(async () => NEWER);
    const onSend = vi.fn((): MarkupSend => "sent");
    const view = (agent: AgentSignal) => <MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PDF} onSend={onSend} agent={agent} refresh={refresh} onClose={() => {}} />;
    const { rerender } = render(view("idle"));
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    expect(await screen.findByText("Sent — waiting for the agent")).toBeTruthy();
    rerender(view("working"));
    vi.useFakeTimers();
    rerender(view("idle"));
    await act(async () => { vi.advanceTimersByTime(SETTLE_MS); });
    vi.useRealTimers();
    // Auto-reload drew the agent's copy.
    await waitFor(() => expect(store.moveLayer).toHaveBeenCalledWith(`p1:outbox:${PDF.name}`, `p1:outbox:${NEWER.name}`, expect.anything()));
    await waitFor(() => expect(calls.some((call) => call.url.endsWith(`/outbox/${NEWER.name}`))).toBe(true));
    store.moveLayer.mockClear();
    const copyFetches = () => calls.filter((call) => call.url.endsWith(`/outbox/${PDF.name}`)).length;
    const fetchedBefore = copyFetches();
    fireEvent.click(undoButton()!);
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Undo the agent's changes from these marks?" })).getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Undone — the files are back as they were before the round.")).toBeTruthy();
    // Back on the copy the round's marks were drawn on, not the agent's.
    await waitFor(() => expect(store.moveLayer).toHaveBeenCalledWith(`p1:outbox:${NEWER.name}`, `p1:outbox:${PDF.name}`, { size: PDF.size, modified: PDF.modified }));
    await waitFor(() => expect(copyFetches()).toBeGreaterThan(fetchedBefore));
    // The agent's turn on the note finishes: its old copy is no new version.
    store.moveLayer.mockClear();
    const looks = refresh.mock.calls.length;
    rerender(view("working"));
    vi.useFakeTimers();
    rerender(view("idle"));
    await act(async () => { vi.advanceTimersByTime(SETTLE_MS); });
    vi.useRealTimers();
    await waitFor(() => expect(refresh.mock.calls.length).toBe(looks + 1));
    expect(await screen.findByText("Agent finished — PDF unchanged")).toBeTruthy();
    expect(store.moveLayer).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledTimes(2);
  });

  it("keeps Apply marks directly as set when the Mark up prompt sheet goes back to the defaults", async () => {
    const { MarkupInstructionSheet } = await import("../../../mobile-web/src/components/MarkupInstructionSheet");
    const { DEFAULT_MARKUP_APPLY_INSTRUCTION, DEFAULT_MARKUP_INSTRUCTION, readMarkupDirect, writeMarkupInstruction: writeInstruction } = await import("../../../mobile-web/src/markupInstruction");
    render(<MarkupInstructionSheet onChange={() => {}} onClose={() => {}} />);
    const field = () => screen.getByRole("textbox", { name: "Instruction" }) as HTMLTextAreaElement;
    expect(field().value).toBe(DEFAULT_MARKUP_APPLY_INSTRUCTION);
    // A default follows the switch to the other mode's default.
    fireEvent.click(screen.getByRole("checkbox", { name: /Apply marks directly/ }));
    expect(field().value).toBe(DEFAULT_MARKUP_INSTRUCTION);
    fireEvent.click(screen.getByRole("button", { name: "Use the default" }));
    expect(readMarkupDirect()).toBe(false);
    cleanup();
    // A user's own instruction is theirs in either mode, and does not follow.
    writeInstruction("Fix typos only.");
    render(<MarkupInstructionSheet onChange={() => {}} onClose={() => {}} />);
    expect(field().value).toBe("Fix typos only.");
    fireEvent.click(screen.getByRole("checkbox", { name: /Apply marks directly/ }));
    expect(field().value).toBe("Fix typos only.");
  });

  it("says which files changed since when the undo is refused, and that nothing was changed", async () => {
    const calls = undoDesktop({ undo: [409, { error: "undo_conflict", files: ["paper.tex"], more: 0 }] });
    const onSend = vi.fn((): MarkupSend => "sent");
    await finishedRound(calls, onSend);
    fireEvent.click(undoButton()!);
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Undo the agent's changes from these marks?" })).getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Can't undo — `paper.tex` changed since. Nothing was changed.")).toBeTruthy();
    expect(onSend).toHaveBeenCalledTimes(1);
    // Still offered: the reader may put the file back and try again.
    expect(undoButton()).toBeTruthy();
  });

  it("says a failed undo plainly, without promising nothing changed", async () => {
    const calls = undoDesktop({ undo: [500, { error: "undo_failed" }] });
    await finishedRound(calls, () => "sent");
    fireEvent.click(undoButton()!);
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Undo the agent's changes from these marks?" })).getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("The undo did not go through (error undo_failed). Check the files before you try again.")).toBeTruthy();
  });

  it("runs a list round with Make these changes and says why there is no undo", async () => {
    const calls = undoDesktop({ submit: { prompt: "Round 1", marked: null, mode: "list", undo: null, noUndo: "not_git" } });
    await finishedRound(calls, () => "sent");
    expect(screen.getByText("No undo here (not a git repository) — the agent lists the changes first.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Make these changes/ })).toBeTruthy();
    expect(undoButton()).toBeNull();
    expect(undoCalls(calls, "settle")).toHaveLength(0);
  });

  it("asks for a list round with Apply marks directly switched off", async () => {
    writeFlag("markupDirect", false);
    const calls = undoDesktop({ submit: { prompt: "Round 1", marked: null, mode: "list", undo: null, noUndo: null } });
    render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={() => "sent"} onClose={() => {}} />);
    showPicture();
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    expect(await screen.findByText("Sent — waiting for the agent")).toBeTruthy();
    expect(markupBodies(calls)[0].mode).toBe("list");
    expect(screen.queryByText(/No undo here/)).toBeNull();
  });
});

describe("Terminal · sendMarkup", () => {
  class FakeWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = FakeWebSocket.OPEN;
    binaryType = "";
    bufferedAmount = 0;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor() { queueMicrotask(() => this.onopen?.()); }
    send() {}
    close() { this.readyState = FakeWebSocket.CLOSED; this.onclose?.(); }
  }

  /** The chat of an agent tab whose outbox lists `files()` at each read. */
  function chat(files: () => unknown[], agentStatus?: "working") {
    localStorage.setItem(storageKey("mobile.view.claude-code"), "focus");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    const calls = desktop();
    const inner = globalThis.fetch as unknown as (input: string, init?: RequestInit) => Promise<Response>;
    vi.stubGlobal("fetch", vi.fn((input: string, init?: RequestInit) => {
      if (!String(input).endsWith("/outbox")) return inner(input, init);
      calls.push({ url: String(input), method: "GET" });
      return Promise.resolve(jsonResponse(200, { files: files() }));
    }));
    const tab = { id: "tab-7", label: "Claude", kind: "agent" as const, agent_label: "Claude Code", agent_status: agentStatus, available: true, viewer_busy: false };
    render(<Terminal tab={tab} back={() => {}} />);
    return calls;
  }

  it("closes nothing and says Queued when the agent is at work", async () => {
    const calls = chat(() => [{ name: "plot.png", kind: "image/png", size: 4_000, modified: 1_790_000_000, from_tab: true }], "working");
    fireEvent.click(await screen.findByRole("button", { name: "Files from the agent (1)" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Files from the agent" })).getByRole("button", { name: "Open plot.png" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "plot.png" })).getByRole("button", { name: "Mark up plot.png" }));
    showPicture();
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());

    await waitFor(() => expect(calls.some((call) => call.url.endsWith("/tabs/tab-7/held"))).toBe(true));
    const held = calls.find((call) => call.url.endsWith("/tabs/tab-7/held"))!;
    expect(JSON.parse(String(held.body))).toEqual({ message: "Round 1" });
    expect(await screen.findByText("Queued — the agent takes it after its current step")).toBeTruthy();
    // The view it was sent from is still open, marking.
    expect(screen.getByRole("dialog", { name: "Mark up plot.png" })).toBeTruthy();
    expect(screen.getByRole("toolbar", { name: "Markup tools" })).toBeTruthy();
  });

  it("reloads the newest copy this tab sent under the same name, and keeps the viewer open", async () => {
    const shown = { name: "paper.pdf", kind: "application/pdf", size: 9_000, modified: 1_790_000_000, from_tab: true };
    const newer = { name: "20261002-090000-paper.pdf", original: "paper.pdf", kind: "application/pdf", size: 9_500, modified: 1_790_090_000, from_tab: true };
    const other = { name: "20261002-100000-paper.pdf", original: "paper.pdf", kind: "application/pdf", size: 1, modified: 1_790_099_000 };
    let listing: unknown[] = [shown];
    store.loadLayer.mockResolvedValue({ layer: markSent(LAYER), fingerprint: { size: shown.size, modified: shown.modified }, saved: 1 });
    chat(() => listing);
    fireEvent.click(await screen.findByRole("button", { name: "Files from the agent (1)" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Files from the agent" })).getByRole("button", { name: "Open paper.pdf" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "paper.pdf" })).getByRole("button", { name: "Mark up paper.pdf" }));
    await waitFor(() => expect(store.loadLayer).toHaveBeenCalled());
    // The agent rebuilt it and sent it again; another tab sent one too.
    listing = [other, newer, shown];
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("button", { name: /Reload PDF/ }));
    await waitFor(() => expect(store.moveLayer).toHaveBeenCalledWith("tab:tab-7:outbox:paper.pdf", `tab:tab-7:outbox:${newer.name}`, { size: newer.size, modified: newer.modified }));
    expect(screen.getByRole("dialog", { name: "Mark up paper.pdf" })).toBeTruthy();
  });
});
