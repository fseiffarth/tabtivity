/**
 * The agent's markup questions on the phone (`docs/markup_questions_mcp_plan.md`
 * P3): the card docked above the markup palette, its rows the Focus list's,
 * the answer sent as picks only (the desktop builds the prompt), the pins the
 * sealed frame places at the quoted words, and the Focus chat's banner.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_LAYER } from "../../../mobile-web/src/markup/layer";

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
import type { MarkupSend } from "../../../mobile-web/src/components/OutboxViewer";
import { acceptFrameMessage, acceptToFrame, MAX_FIND_QUOTE, MAX_FOUND_RECTS } from "../../../mobile-web/src/markup/frameProtocol";
import { findQuote, type TextRun } from "../../../mobile-web/src/markup/findText";
import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { storageKey } from "../../lib/brand";
import { answersOf, NO_PICK, toggleOption } from "../../lib/viewers/markupQuestionPicks";

const PICTURE = { name: "20261001-120000-plot.png", original: "plot.png", kind: "image/png", size: 4_000, modified: 1_790_000_000 };
const PDF = { name: "20261001-120000-paper.pdf", original: "paper.pdf", kind: "application/pdf", size: 9_000, modified: 1_790_000_000 };
const ASK = "ask-0123456789abcdef";

type Call = { url: string; method: string; body?: BodyInit | null };
type Answer = { status: number; body: unknown };

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The sidecar: the asks at `/markup/questions`, the answer and dismissal
 * routes, a PDF's bytes and the tab's outbox. */
function desktop(asks: () => unknown[], answer: () => Answer = () => ({ status: 200, body: { answered: true } }), outbox: () => unknown[] = () => []) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body });
    if (url.includes("/markup/questions")) return jsonResponse(200, { asks: asks() });
    if (url.endsWith("/markup/answer")) { const { status, body } = answer(); return jsonResponse(status, body); }
    if (url.endsWith("/markup/dismiss")) return jsonResponse(200, { dismissed: true });
    if (url.endsWith(".pdf")) return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 });
    if (url.endsWith("/outbox")) return jsonResponse(200, { files: outbox() });
    if (url.includes("/transcript")) return jsonResponse(200, { transcript: { available: true, version: "v1", truncated: false, entries: [] } });
    if (url.endsWith("/schedules")) return jsonResponse(200, { schedules: [], time_zone: "UTC", next_runs: {} });
    return jsonResponse(200, {});
  }));
  return calls;
}

const posted = (calls: Call[], suffix: string) => calls.filter((call) => call.url.endsWith(suffix)).map((call) => JSON.parse(String(call.body)));

const ONE = {
  id: ASK,
  file_name: "plot.png",
  questions: [{ question: "Move the figure or the paragraph?", header: "Arrow", options: [{ label: "The figure (Recommended)" }, { label: "The paragraph", description: "Above it" }], multi_select: false, page: 1, quote: "as shown in Figure 2" }],
};
const TWO = {
  id: ASK,
  questions: [
    { question: "Which spelling?", options: [{ label: "colour" }, { label: "color" }], multi_select: true },
    { question: "Keep the caption?", options: [{ label: "Yes" }, { label: "No" }], multi_select: false },
  ],
};

beforeEach(() => {
  localStorage.clear();
  store.loadLayer.mockReset();
  store.loadLayer.mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("findQuote · where a question's words sit on its page", () => {
  const runs: TextRun[] = [
    { str: "As sho", x: 10, y: 100, w: 60, h: 12 },
    { str: "wn in Fig-", x: 70, y: 100, w: 100, h: 12, eol: true },
    { str: "ure 2, the ﬁrst", x: 10, y: 114, w: 150, h: 12 },
  ];

  it("finds a quote across kerned runs, a hyphenated line break, case and ligatures", () => {
    const rects = findQuote(runs, "as shown in figure 2");
    expect(rects).toHaveLength(3);
    expect(rects[0]).toEqual({ x: 10, y: 100, w: 60, h: 12 });
    // "ure 2" is the first five characters of the third run's fifteen.
    expect(rects[2]).toEqual({ x: 10, y: 114, w: 50, h: 12 });
    expect(findQuote(runs, "the first")).toHaveLength(1);
  });

  it("falls back to the first six words, and finds nothing it should not", () => {
    expect(findQuote(runs, "as shown in Figure 2, the first one of many below")).toHaveLength(3);
    expect(findQuote(runs, "not on this page")).toEqual([]);
    expect(findQuote(runs, "   ")).toEqual([]);
  });

  it("answers no more boxes than the frame may send", () => {
    const many = Array.from({ length: 80 }, (_, i): TextRun => ({ str: "a", x: i, y: 0, w: 1, h: 1 }));
    expect(findQuote(many, "a".repeat(80))).toHaveLength(MAX_FOUND_RECTS);
  });
});

describe("sealed frame · findText", () => {
  const holder = document.createElement("iframe");
  document.body.append(holder);
  const frame = holder.contentWindow!;
  const from = (data: unknown) => new MessageEvent("message", { data, origin: "null", source: frame });

  it("takes a bounded request and a bounded answer only", () => {
    expect(acceptToFrame({ type: "findText", id: 3, page: 2, quote: "Figure 2" })).toEqual({ type: "findText", id: 3, page: 2, quote: "Figure 2" });
    for (const bad of [
      { type: "findText", id: 3, page: 0, quote: "x" },
      { type: "findText", id: -1, page: 1, quote: "x" },
      { type: "findText", id: 3, page: 1, quote: "  " },
      { type: "findText", id: 3, page: 1, quote: "x".repeat(MAX_FIND_QUOTE + 1) },
      { type: "findText", id: 3, page: 1 },
    ]) expect(acceptToFrame(bad)).toBeNull();

    const rect = { x: 10, y: 20, w: 30, h: 12 };
    expect(acceptFrameMessage(from({ type: "found", id: 3, page: 2, rects: [rect] }), frame, 3)).toEqual({ type: "found", id: 3, page: 2, rects: [rect] });
    expect(acceptFrameMessage(from({ type: "found", id: 3, page: 2, rects: [] }), frame, 3)).toEqual({ type: "found", id: 3, page: 2, rects: [] });
    for (const bad of [
      { type: "found", id: 3, page: 4, rects: [] },
      { type: "found", id: 1.5, page: 1, rects: [] },
      { type: "found", id: 3, page: 1, rects: [{ ...rect, w: -1 }] },
      { type: "found", id: 3, page: 1, rects: [{ ...rect, x: Number.NaN }] },
      { type: "found", id: 3, page: 1, rects: [{ ...rect, x: "10" }] },
      { type: "found", id: 3, page: 1, rects: Array.from({ length: MAX_FOUND_RECTS + 1 }, () => rect) },
      { type: "found", id: 3, page: 1, rects: [rect], html: "<b>" },
    ]) {
      const accepted = acceptFrameMessage(from(bad), frame, 3);
      // An extra key is dropped, never passed on.
      if (accepted) expect(Object.keys(accepted).sort()).toEqual(["id", "page", "rects", "type"]);
      else expect(accepted).toBeNull();
    }
  });
});

describe("the pick model the phone shares with the desktop", () => {
  it("answers a single-select tap and waits for every multiSelect question", () => {
    const single = { question: "q", options: [{ label: "a" }, { label: "b" }], multiSelect: false };
    expect(answersOf([single], [toggleOption(single, NO_PICK, 1)])).toEqual([{ options: [1] }]);
    const multi = { ...single, multiSelect: true };
    expect(answersOf([multi, single], [toggleOption(multi, NO_PICK, 0), NO_PICK])).toBeNull();
  });
});

describe("MarkupView · the agent's questions", () => {
  function showPicture() {
    const image = screen.getByAltText("plot.png") as HTMLImageElement;
    Object.defineProperty(image, "naturalWidth", { value: 800 });
    Object.defineProperty(image, "naturalHeight", { value: 600 });
    fireEvent.load(image);
  }

  it("asks for this file's questions and answers one tap as picks, never prompt text", async () => {
    let asks: unknown[] = [ONE];
    const calls = desktop(() => asks);
    const onSend = vi.fn((): MarkupSend => "sent");
    render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={onSend} onClose={() => {}} />);
    showPicture();
    const card = await screen.findByRole("region", { name: "The agent's questions about your marks" });
    expect(within(card).getByText("The agent asks · 1")).toBeTruthy();
    expect(within(card).getByText("Recommended")).toBeTruthy();
    // A picture has no text to pin to: no chip, no pin.
    expect(within(card).queryByRole("button", { name: /Show on page/ })).toBeNull();
    const asked = calls.find((call) => call.url.includes("/markup/questions"))!;
    expect(asked.url).toBe(`/api/v1/tabs/t1/markup/questions?source=${encodeURIComponent(`outbox:${PICTURE.name}`)}`);

    asks = [];
    fireEvent.click(within(card).getByRole("button", { name: /The paragraph/ }));
    await waitFor(() => expect(posted(calls, "/markup/answer")).toEqual([{ ask_id: ASK, answers: [{ options: [1] }] }]));
    await waitFor(() => expect(screen.queryByRole("region", { name: "The agent's questions about your marks" })).toBeNull());
    // The chat gets nothing from the phone: the desktop queued the answer.
    expect(onSend).not.toHaveBeenCalled();
    expect(await screen.findByText("Sent — waiting for the agent")).toBeTruthy();
  });

  it("picks several answers, takes a typed Other…, and sends them together", async () => {
    const calls = desktop(() => [TWO]);
    render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={() => "sent"} onClose={() => {}} />);
    showPicture();
    const card = await screen.findByRole("region", { name: "The agent's questions about your marks" });
    const send = within(card).getByRole("button", { name: "Send answers" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(within(card).getByRole("button", { name: /colour/ }));
    fireEvent.click(within(card).getByRole("button", { name: "color" }));
    expect(within(card).getAllByRole("button", { pressed: true })).toHaveLength(2);
    const others = within(card).getAllByRole("button", { name: /Other…/ });
    fireEvent.click(others[1]);
    fireEvent.change(within(card).getByRole("textbox"), { target: { value: "  only in the appendix " } });
    fireEvent.click(within(card).getByRole("button", { name: "OK" }));
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(posted(calls, "/markup/answer")).toEqual([
      { ask_id: ASK, answers: [{ options: [0, 1] }, { options: [], other: "only in the appendix" }] },
    ]));
  });

  it("keeps the card when the answer could not be delivered, and closes it to answer in the chat", async () => {
    const calls = desktop(() => [TWO], () => ({ status: 409, body: { error: "delivery_failed" } }));
    render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={() => "sent"} onClose={() => {}} />);
    showPicture();
    const card = await screen.findByRole("region", { name: "The agent's questions about your marks" });
    fireEvent.click(within(card).getByRole("button", { name: /colour/ }));
    fireEvent.click(within(card).getByRole("button", { name: /Yes/ }));
    fireEvent.click(within(card).getByRole("button", { name: "Send answers" }));
    expect(await within(card).findByRole("alert")).toBeTruthy();
    expect(within(card).getByRole("alert").textContent).toContain("still open");

    fireEvent.click(within(card).getByRole("button", { name: "Answer in chat instead" }));
    await waitFor(() => expect(posted(calls, "/markup/dismiss")).toEqual([{ ask_id: ASK }]));
    await waitFor(() => expect(screen.queryByRole("region", { name: "The agent's questions about your marks" })).toBeNull());
  });

  it("folds away and opens again when a new ask arrives", async () => {
    let asks: unknown[] = [ONE];
    desktop(() => asks);
    render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={() => "sent"} onClose={() => {}} />);
    showPicture();
    const card = await screen.findByRole("region", { name: "The agent's questions about your marks" });
    fireEvent.click(within(card).getByRole("button", { name: /The agent asks · 1/ }));
    expect(within(card).queryByText("Move the figure or the paragraph?")).toBeNull();
    asks = [{ ...ONE, id: "ask-fedcba9876543210" }];
    await waitFor(() => expect(within(card).getByText("Move the figure or the paragraph?")).toBeTruthy(), { timeout: 5_000 });
  });

  it("never asks while the page is hidden, and not in a view that cannot answer", async () => {
    const calls = desktop(() => [ONE]);
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { unmount } = render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={() => "sent"} onClose={() => {}} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(calls.some((call) => call.url.includes("/markup/questions"))).toBe(false);
    hidden.mockRestore();
    unmount();
    // No agent tab to answer into (a new-tab Submit): no card, no poll.
    render(<MarkupView projectId="p1" scope={{ tab: "t1" }} file={PICTURE} newTab={{ projectId: "p1", show: () => {} }} onClose={() => {}} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(calls.some((call) => call.url.includes("/markup/questions"))).toBe(false);
  });

  it("pins a PDF question at the words the sealed frame found, and the pin opens its question", async () => {
    desktop(() => [{ ...ONE, file_name: "paper.pdf" }]);
    store.loadLayer.mockResolvedValue({ layer: EMPTY_LAYER, fingerprint: { size: PDF.size, modified: PDF.modified }, saved: 1 });
    const { container } = render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PDF} onSend={() => "sent"} onClose={() => {}} />);
    const iframe = container.querySelector("iframe.markup-frame") as HTMLIFrameElement;
    const frame = iframe.contentWindow!;
    const sent: unknown[] = [];
    vi.spyOn(frame, "postMessage").mockImplementation((message: unknown) => { sent.push(message); });
    const say = (data: unknown) => act(() => { window.dispatchEvent(new MessageEvent("message", { data, origin: "null", source: frame })); });
    say({ type: "ready" });
    say({ type: "meta", pages: [{ w: 600, h: 800 }] });
    const card = await screen.findByRole("region", { name: "The agent's questions about your marks" });
    // In the margin until the frame answers.
    const pin = await screen.findByRole("button", { name: "Question 1 — show it in the card" });
    expect(pin.style.left).toBe("6px");
    await waitFor(() => expect(sent.some((message) => (message as { type?: string }).type === "findText")).toBe(true));
    const find = sent.find((message) => (message as { type?: string }).type === "findText") as { id: number; page: number; quote: string };
    expect(find).toMatchObject({ page: 1, quote: "as shown in Figure 2" });
    say({ type: "found", id: find.id, page: 1, rects: [{ x: 100, y: 200, w: 50, h: 10 }] });
    // 336 px wide for a 600 pt page: the badge sits just above-left of the words.
    await waitFor(() => expect(pin.style.left).toBe(`${100 * (336 / 600) - 12}px`));
    expect(pin.style.top).toBe(`${200 * (336 / 600) - 26}px`);

    fireEvent.click(within(card).getByRole("button", { name: /The agent asks · 1/ }));
    expect(within(card).queryByText("Move the figure or the paragraph?")).toBeNull();
    fireEvent.click(pin);
    expect(within(card).getByText("Move the figure or the paragraph?")).toBeTruthy();
    expect(container.querySelector(".markup-question.flash")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Show on page 1" }));
    expect(container.querySelector(".markup-pin-hit")).toBeTruthy();
  });
});

describe("Terminal · the Focus banner", () => {
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

  function chat(asks: () => unknown[], outbox: () => unknown[]) {
    localStorage.setItem(storageKey("mobile.view.claude-code"), "focus");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    const calls = desktop(asks, undefined, outbox);
    const tab = { id: "tab-7", label: "Claude", kind: "agent" as const, agent_label: "Claude Code", available: true, viewer_busy: false };
    render(<Terminal tab={tab} back={() => {}} />);
    return calls;
  }

  it("says the agent asks about a file the outbox has, and opens it", async () => {
    const calls = chat(() => [{ ...ONE, file_name: "paper.pdf" }], () => [PDF]);
    expect(await screen.findByText(/The agent asks about paper\.pdf/)).toBeTruthy();
    expect(calls.find((call) => call.url.includes("/markup/questions"))!.url).toBe("/api/v1/tabs/tab-7/markup/questions");
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect(await screen.findByRole("dialog", { name: "paper.pdf" })).toBeTruthy();
  });

  it("names a file it cannot open without offering to", async () => {
    chat(() => [{ ...ONE, file_name: "draft.pdf" }], () => []);
    expect(await screen.findByText(/The agent asks about draft\.pdf in its markup view/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  });
});
