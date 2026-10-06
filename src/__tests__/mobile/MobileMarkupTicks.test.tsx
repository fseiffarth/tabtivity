/**
 * The agent's ticks on the phone (`markup_done`, `docs/markup_tick_approve_plan.md`
 * P3): Submit sends a round id, the ticks come with the questions poll, each
 * ticked sent mark wears a ✓ that a tap approves (the mark leaves the layer),
 * never in the moment after the badge appeared, and "n done · Approve all"
 * sits under the round's pill. Nothing else removes a mark.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMark, EMPTY_LAYER, markBox, markSent, type Layer } from "../../../mobile-web/src/markup/layer";

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

import { readMarkupQuestions } from "../../../mobile-web/src/api";
import { MarkupView } from "../../../mobile-web/src/components/MarkupView";
import { ARRIVAL_GUARD_MS } from "../../../mobile-web/src/components/MarkupQuestionsCard";
import type { MarkupSend } from "../../../mobile-web/src/components/OutboxViewer";
import { SETTLE_MS, type AgentSignal } from "../../../mobile-web/src/markup/submitState";
import { NAMES } from "../../lib/brand";

const PICTURE = { name: "20261001-120000-plot.png", original: "plot.png", kind: "image/png", size: 4_000, modified: 1_790_000_000 };
const PDF = { name: "20261001-120000-paper.pdf", original: "paper.pdf", kind: "application/pdf", size: 9_000, modified: 1_790_000_000 };
const ROUND = "abcd1234";
const STROKE = { kind: "ink" as const, color: "red" as const, width: 2, points: [[10, 10, 0.5], [40, 30, 0.5]] as [number, number, number][] };
const BOX = { kind: "box" as const, color: "yellow" as const, rect: [100, 200, 80, 40] as [number, number, number, number] };
/** One unsent stroke on the picture's page. */
const FRESH = addMark(EMPTY_LAYER, 1, [800, 600], STROKE);
/** The stroke and the box, sent as round `ROUND`. */
const SENT = markSent(addMark(FRESH, 1, [800, 600], BOX), [1], ROUND);

type Call = { url: string; method: string; body?: BodyInit | null };

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** The sidecar: `/markup/questions` answers no asks and `answer()` beside
 * them (`{ ticks }`, or nothing of an older one), plus the Submit routes. */
function desktop(answer: () => Record<string, unknown>, submitted: Record<string, unknown> = { prompt: "Round 1", marked: null }) {
  const calls: Call[] = [];
  let uploads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body });
    if (url.includes("/markup/questions")) return jsonResponse(200, { asks: [], ...answer() });
    if (url.includes("/inbox?name=")) {
      uploads += 1;
      const name = decodeURIComponent(url.split("name=")[1]);
      return jsonResponse(201, { attachment: { name, reference: `${NAMES.inboxDir}/2026-${uploads}-${name}`, size: 6 } });
    }
    if (url.endsWith("/markup")) return jsonResponse(200, submitted);
    if (url.endsWith("/settle")) return jsonResponse(200, {});
    if (url.includes("/markup/undo/")) return jsonResponse(200, { files: [{ path: "plot.py", change: "modified" }], more: 0, pdf: "none" });
    if (url.endsWith(".pdf")) return new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 });
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

function stored(layer: Layer, file = PICTURE) {
  store.loadLayer.mockResolvedValue({ layer, fingerprint: { size: file.size, modified: file.modified }, saved: 1 });
}

/** The layer the view saved last. */
function saved(): Layer {
  const calls = store.saveLayer.mock.calls as unknown as [string, Layer][];
  return calls[calls.length - 1][1];
}

const badges = () => screen.queryAllByRole("button", { name: /ticked this mark off as done/ });
const approveAll = () => screen.queryByRole("button", { name: "Approve all" });

let skew = 0;
/** Past the badges' arrival guard. */
const settle = () => { skew += ARRIVAL_GUARD_MS; };
let clock: { mockRestore: () => void } | null = null;

beforeEach(() => {
  localStorage.clear();
  skew = 0;
  const real = Date.now.bind(Date);
  clock = vi.spyOn(Date, "now").mockImplementation(() => real() + skew);
  store.loadLayer.mockReset();
  store.saveLayer.mockClear();
});
afterEach(() => {
  clock?.mockRestore();
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("readMarkupQuestions · the ticks beside the asks", () => {
  it("keeps well-formed ticks only, none without a source, none from an older sidecar", async () => {
    let answer: Record<string, unknown> = {
      ticks: [
        { round: ROUND, page: 1, mark: 2, path: "/home/x/paper.pdf" },
        { round: "", page: 1, mark: 1 },
        { round: ROUND, page: 0, mark: 1 },
        { round: ROUND, page: 1, mark: 1.5 },
        { round: 7, page: 1, mark: 1 },
        null,
      ],
    };
    desktop(() => answer);
    const shown = await readMarkupQuestions("t1", { outbox: PICTURE.name });
    expect(shown).toEqual({ asks: [], ticks: [{ round: ROUND, page: 1, mark: 2 }] });
    // The Focus banner: every file's ticks, which mean nothing there.
    expect((await readMarkupQuestions("t1")).ticks).toEqual([]);
    answer = {};
    expect((await readMarkupQuestions("t1", { outbox: PICTURE.name })).ticks).toEqual([]);
    answer = { ticks: "nope" };
    expect((await readMarkupQuestions("t1", { outbox: PICTURE.name })).ticks).toEqual([]);
  });
});

describe("MarkupView · the agent's ticks", () => {
  it("sends a round with the Submit, and the agent's tick on it brings a ✓", async () => {
    stored(FRESH);
    let ticks: unknown[] = [];
    const calls = desktop(() => ({ ticks }));
    const onSend = vi.fn((): MarkupSend => "sent");
    const view = (agent: AgentSignal) => <MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={onSend} agent={agent} onClose={() => {}} />;
    const { rerender } = render(view("idle"));
    showPicture();
    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Round 1"));
    const body = JSON.parse(String(calls.find((call) => call.url.endsWith("/markup"))!.body));
    expect(body.round).toMatch(/^[a-z0-9]{8}$/);
    // The round is logged with the marks exactly as the request listed them.
    await waitFor(() => expect(saved().sent?.log).toEqual([{ id: body.round, pages: { 1: FRESH.pages[1].marks } }]));
    expect(badges()).toHaveLength(0);

    // The agent ticks it off; the next read (here: the agent's edge) shows it.
    ticks = [{ round: body.round, page: 1, mark: 1 }, { round: "zzzz9999", page: 1, mark: 1 }];
    rerender(view("working"));
    await waitFor(() => expect(badges()).toHaveLength(1));
    expect(screen.getByText("1 done")).toBeTruthy();
    // At the stroke's top-right corner, on a 336 px wide picture of 800.
    const [x, y, w] = markBox(STROKE);
    const scale = 336 / 800;
    expect(badges()[0].style.left).toBe(`${(x + w) * scale - 13}px`);
    expect(badges()[0].style.top).toBe(`${Math.max(0, y * scale - 13)}px`);
  });

  it("approves a ticked mark on a tap — never in the moment after the ✓ appeared, never twice — and ↶ brings it back", async () => {
    stored(SENT);
    desktop(() => ({ ticks: [{ round: ROUND, page: 1, mark: 2 }] }));
    render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={() => "sent"} onClose={() => {}} />);
    showPicture();
    await waitFor(() => expect(badges()).toHaveLength(1));
    // A pen mid-stroke where the badge lands: nothing goes.
    fireEvent.click(badges()[0]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(badges()).toHaveLength(1);
    expect(store.saveLayer).not.toHaveBeenCalled();

    settle();
    // A double tap's second click is no approval.
    fireEvent.click(badges()[0], { detail: 2 });
    expect(badges()).toHaveLength(1);
    fireEvent.click(badges()[0], { detail: 1 });
    await waitFor(() => expect(badges()).toHaveLength(0));
    expect(screen.queryByText("1 done")).toBeNull();
    // Only the ticked box went; the stroke stays sent.
    await waitFor(() => expect(saved().sent?.pages[1].marks).toEqual([STROKE]));

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(badges()).toHaveLength(1));
    await waitFor(() => expect(saved().sent?.pages[1].marks).toEqual([STROKE, BOX]));
  });

  it("approves every ticked mark with Approve all, not in the moment after a ✓ appeared", async () => {
    stored(SENT);
    desktop(() => ({ ticks: [{ round: ROUND, page: 1, mark: 1 }, { round: ROUND, page: 1, mark: 2 }, { round: "other123", page: 1, mark: 1 }] }));
    render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={() => "sent"} onClose={() => {}} />);
    showPicture();
    await waitFor(() => expect(badges()).toHaveLength(2));
    expect(screen.getByText("2 done")).toBeTruthy();
    fireEvent.click(approveAll()!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(badges()).toHaveLength(2);
    settle();
    fireEvent.click(approveAll()!);
    await waitFor(() => expect(badges()).toHaveLength(0));
    expect(approveAll()).toBeNull();
    await waitFor(() => expect(saved().sent?.pages[1]).toBeUndefined());
  });

  it("shows nothing from an older sidecar without ticks, and keeps every mark", async () => {
    stored(SENT);
    const calls = desktop(() => ({}));
    render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={() => "sent"} onClose={() => {}} />);
    showPicture();
    await waitFor(() => expect(calls.some((call) => call.url.includes("/markup/questions"))).toBe(true));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(badges()).toHaveLength(0);
    expect(approveAll()).toBeNull();
    expect(store.saveLayer).not.toHaveBeenCalled();
  });

  it("hides the badges and Approve all while the sent marks are hidden", async () => {
    stored(SENT);
    desktop(() => ({ ticks: [{ round: ROUND, page: 1, mark: 1 }] }));
    render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={() => "sent"} onClose={() => {}} />);
    showPicture();
    await waitFor(() => expect(badges()).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("switch", { name: /Show sent marks/ }));
    expect(badges()).toHaveLength(0);
    expect(approveAll()).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: /Show sent marks/ }));
    expect(badges()).toHaveLength(1);
  });

  it("forgets an undone apply round: its ticks badge nothing, its marks stay", async () => {
    stored(FRESH);
    let ticks: unknown[] = [];
    const calls = desktop(() => ({ ticks }), { prompt: "Round 1", marked: null, mode: "apply", undo: "0123456789abcdef0123456789abcdef", noUndo: null });
    const onSend = vi.fn((): MarkupSend => "sent");
    const view = (agent: AgentSignal) => <MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PICTURE} onSend={onSend} agent={agent} onClose={() => {}} />;
    const { rerender } = render(view("idle"));
    showPicture();
    const submit = screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Round 1"));
    const round = JSON.parse(String(calls.find((call) => call.url.endsWith("/markup"))!.body)).round as string;
    ticks = [{ round, page: 1, mark: 1 }];
    rerender(view("working"));
    await waitFor(() => expect(badges()).toHaveLength(1));
    vi.useFakeTimers();
    rerender(view("idle"));
    await act(async () => { vi.advanceTimersByTime(SETTLE_MS); });
    vi.useRealTimers();
    fireEvent.click(await screen.findByRole("button", { name: "Undo the agent's changes from this round" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Undo the agent's changes from these marks?" })).getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Undone — the files are back as they were before the round.")).toBeTruthy();
    await waitFor(() => expect(badges()).toHaveLength(0));
    await waitFor(() => expect(saved().sent).toEqual({ pages: FRESH.pages, rounds: 1 }));
  });

  it("puts a PDF page's ✓ at its mark's corner, kept on the page", async () => {
    const corner = { kind: "box" as const, color: "yellow" as const, rect: [560, 0, 40, 30] as [number, number, number, number] };
    stored(markSent(addMark(EMPTY_LAYER, 1, [600, 800], corner), [1], ROUND), PDF);
    desktop(() => ({ ticks: [{ round: ROUND, page: 1, mark: 1 }] }));
    const { container } = render(<MarkupView tabId="t1" projectId="p1" scope={{ tab: "t1" }} file={PDF} onSend={() => "sent"} onClose={() => {}} />);
    const frame = (container.querySelector("iframe.markup-frame") as HTMLIFrameElement).contentWindow!;
    vi.spyOn(frame, "postMessage").mockImplementation(() => {});
    const say = (data: unknown) => act(() => { window.dispatchEvent(new MessageEvent("message", { data, origin: "null", source: frame })); });
    say({ type: "ready" });
    say({ type: "meta", pages: [{ w: 600, h: 800 }] });
    await waitFor(() => expect(badges()).toHaveLength(1));
    // The box's corner is the page's: the badge stays inside, 336 px wide.
    expect(badges()[0].style.left).toBe(`${336 - 26}px`);
    expect(badges()[0].style.top).toBe("0px");
  });
});
