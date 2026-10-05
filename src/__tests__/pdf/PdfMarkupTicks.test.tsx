/**
 * The agent's ticks on the desktop (`markup_done`,
 * `docs/markup_tick_approve_plan.md` §3): a Submit carries a fresh round id
 * and logs its marks; `usePdfMarkup` reads the ticks on `markup-mcp-changed`
 * and maps them onto the sent marks; each gets a ✓ (`PdfTickBadges`) whose
 * click approves — removes — that mark, undoably; the strip says "n done ·
 * Approve all". A backend without the command shows no ticks, and an undone
 * apply round's ticks show nothing.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, () => void>(),
  queuePromptForTab: vi.fn(),
  holdPhonePrompt: vi.fn(),
  loadLayer: vi.fn(),
  saveLayer: vi.fn(async () => true),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: () => void) => {
    mocks.listeners.set(event, handler);
    return () => mocks.listeners.delete(event);
  }),
}));
vi.mock("../../stores/agents/agentPrompts", () => ({ queuePromptForTab: mocks.queuePromptForTab }));
vi.mock("../../lib/agents/phoneHolds", () => ({ holdPhonePrompt: mocks.holdPhonePrompt }));
vi.mock("../../../mobile-web/src/markup/store", async (original) => ({
  ...(await original<typeof import("../../../mobile-web/src/markup/store")>()),
  loadLayer: mocks.loadLayer,
  saveLayer: mocks.saveLayer,
}));
vi.mock("../../../mobile-web/src/markup/rasterize", async (original) => ({
  ...(await original<typeof import("../../../mobile-web/src/markup/rasterize")>()),
  layerPng: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
}));

import { PdfMarkupBar } from "../../components/embed/pdf/PdfMarkupBar";
import { PdfTickBadges, tickBadgesByPage } from "../../components/embed/pdf/PdfMarkupTicks";
import { usePdfMarkup } from "../../components/embed/pdf/usePdfMarkup";
import { useActivityStore } from "../../stores/activity";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { SETTLE_MS } from "../../../mobile-web/src/markup/submitState";
import { EMPTY_LAYER, addMark, type Layer, type Mark } from "../../../mobile-web/src/markup/layer";
import type { MarkupTick } from "../../lib/viewers/markupQuestions";

const PATH = "/home/u/paper/paper.pdf";
const SIZE: [number, number] = [595, 842];
const STROKE: Mark = { kind: "ink", color: "red", width: 1.7, points: [[10, 10, 0.5], [40, 30, 0.5]] };
const BOX: Mark = { kind: "box", color: "yellow", rect: [100, 200, 50, 10] };
const LAYER = addMark(addMark(EMPTY_LAYER, 1, SIZE, STROKE), 1, SIZE, BOX);
const UNDO_ID = "0123456789abcdef0123456789abcdef";

function agentTab(key: string, scheduleTargetId: string, label: string): TabEntry {
  return { key, label, cmd: "claude", cwd: "/home/u/paper", kind: "agent", scheduleTargetId } as TabEntry;
}

function Harness({ onReload = () => {} }: { onReload?: () => void }) {
  const markup = usePdfMarkup({
    projectId: "p1",
    scope: "p1",
    path: PATH,
    active: true,
    visible: true,
    pageCount: 3,
    docSize: 9_000,
    docVersion: 0,
  });
  const badges = tickBadgesByPage(markup.edit.base, markup.ticks.marks).get(1) ?? [];
  return (
    <>
      <PdfMarkupBar markup={markup} page={1} onReload={onReload} onDone={() => {}} />
      <div data-testid="page-1">
        <PdfTickBadges badges={badges} size={SIZE} scale={1} disabled={markup.sending} onApprove={(index, mark) => markup.ticks.approve(1, index, mark)} />
      </div>
    </>
  );
}

let ticks: MarkupTick[] | "missing" = [];
let submitMode: { mode: string; undo: string | null } = { mode: "list", undo: null };
/** Per-tab ticks, when a test needs them to differ by tab. */
let ticksFor: ((target: string) => MarkupTick[]) | null = null;

const calls = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command);
const ring = () => act(() => mocks.listeners.get("markup-mcp-changed")?.());
const submitButton = () => screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
const badges = () => within(screen.getByTestId("page-1")).queryAllByRole("button");
const lastSaved = (): Layer | undefined => {
  const saved = mocks.saveLayer.mock.calls as unknown as [string, Layer][];
  return saved[saved.length - 1]?.[1];
};

beforeEach(() => {
  ticks = [];
  ticksFor = null;
  submitMode = { mode: "list", undo: null };
  mocks.listeners.clear();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args: { scheduleTargetId: string }) => {
    if (command === "file_mtime") return 1_790_000_000;
    if (command === "markup_mcp_list") return [];
    if (command === "markup_mcp_ticks") {
      if (ticks === "missing") throw "command markup_mcp_ticks not found";
      return ticksFor ? ticksFor(args.scheduleTargetId) : ticks;
    }
    if (command === "pdf_markup_submit") return { prompt: "Look at the marked copy.", marked: null, ...submitMode, noUndo: null };
    if (command === "pdf_markup_undo_preview" || command === "pdf_markup_undo") return { files: [{ path: "paper.tex", change: "modified" }], more: 0, pdf: "restored" };
    return null;
  });
  mocks.queuePromptForTab.mockReset();
  mocks.queuePromptForTab.mockResolvedValue({ pruned: 0, id: "sched-1" });
  mocks.holdPhonePrompt.mockReset();
  mocks.loadLayer.mockReset();
  mocks.loadLayer.mockResolvedValue({ layer: LAYER, fingerprint: { size: 9_000, modified: 1_790_000_000 }, saved: 1 });
  mocks.saveLayer.mockClear();
  useTabsStore.setState({ tabsByScope: { p1: [agentTab("t1", "s1", "Claude")] } });
  useActivityStore.setState({ busyByTab: {}, attentionByTab: {} });
  useSettingsStore.setState({ settings: null });
});
afterEach(() => cleanup());

/** Submits the layer's two marks and answers the round id it went with. */
async function submitted(): Promise<string> {
  await waitFor(() => expect(submitButton().disabled).toBe(false));
  fireEvent.click(submitButton());
  await waitFor(() => expect(mocks.holdPhonePrompt).toHaveBeenCalled());
  const round = calls("pdf_markup_submit")[0][1].round as string;
  await waitFor(() => expect(lastSaved()?.sent?.log?.[0]?.id).toBe(round));
  return round;
}

describe("desktop markup ticks", () => {
  it("sends a fresh round id with each Submit and logs the marks as sent", async () => {
    render(<Harness />);
    const round = await submitted();
    expect(round).toMatch(/^[a-z0-9]{8}$/);
    expect(lastSaved()?.sent?.log).toEqual([{ id: round, pages: { 1: [STROKE, BOX] } }]);
  });

  it("shows a ✓ on each ticked sent mark and approves one with a click — undoably", async () => {
    render(<Harness />);
    const round = await submitted();
    expect(badges()).toHaveLength(0);
    ticks = [{ round, page: 1, mark: 2 }];
    ring();
    await waitFor(() => expect(badges()).toHaveLength(1));
    expect(screen.getByText("1 done")).toBeTruthy();
    // At the box's top-right corner.
    expect(badges()[0].style.left).toBe(`${150 - 11}px`);
    expect(badges()[0].style.top).toBe(`${200 - 11}px`);
    expect(calls("markup_mcp_ticks")[calls("markup_mcp_ticks").length - 1]?.[1]).toEqual({ projectId: "p1", scheduleTargetId: "s1", path: PATH });
    fireEvent.click(badges()[0]);
    await waitFor(() => expect(lastSaved()?.sent?.pages[1].marks).toEqual([STROKE]));
    expect(badges()).toHaveLength(0);
    expect(screen.queryByText("1 done")).toBeNull();
    // Undo brings the mark back, and its tick with it.
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(lastSaved()?.sent?.pages[1].marks).toEqual([STROKE, BOX]));
    expect(badges()).toHaveLength(1);
  });

  it("a double click approves one mark, never the badge that slides under the pointer", async () => {
    render(<Harness />);
    const round = await submitted();
    ticks = [{ round, page: 1, mark: 1 }, { round, page: 1, mark: 2 }];
    ring();
    await waitFor(() => expect(badges()).toHaveLength(2));
    const first = badges()[0];
    fireEvent.click(first, { detail: 1 });
    fireEvent.click(first, { detail: 2 });
    await waitFor(() => expect(lastSaved()?.sent?.pages[1].marks).toEqual([BOX]));
    expect(badges()).toHaveLength(1);
    // The approved mark's button went with it: the box's is a new one.
    expect(badges()[0]).not.toBe(first);
  });

  it("an approve for a mark no longer at its place removes nothing", async () => {
    let approve: ((page: number, index: number, mark: Mark) => void) | null = null;
    function Grab() {
      const markup = usePdfMarkup({ projectId: "p1", scope: "p1", path: PATH, active: true, visible: true, pageCount: 3, docSize: 9_000, docVersion: 0 });
      approve = markup.ticks.approve;
      return <PdfMarkupBar markup={markup} page={1} onReload={() => {}} onDone={() => {}} />;
    }
    render(<Grab />);
    const round = await submitted();
    ticks = [{ round, page: 1, mark: 1 }, { round, page: 1, mark: 2 }];
    ring();
    expect(await screen.findByText("2 done")).toBeTruthy();
    const saves = mocks.saveLayer.mock.calls.length;
    // A badge drawn for the stroke, clicked after the box took its index.
    act(() => approve!(1, 1, STROKE));
    act(() => approve!(1, 5, BOX));
    expect(screen.getByText("2 done")).toBeTruthy();
    expect(mocks.saveLayer.mock.calls.length).toBe(saves);
  });

  it("shows the ticks of every agent tab of the project, whichever the round went to", async () => {
    useTabsStore.setState({ tabsByScope: { p1: [agentTab("t1", "s1", "Claude"), agentTab("t2", "s2", "Codex")] } });
    render(<Harness />);
    const round = await submitted();
    ticksFor = (target) => (target === "s2" ? [{ round, page: 1, mark: 1 }] : []);
    ring();
    await waitFor(() => expect(badges()).toHaveLength(1));
    const asked = new Set(calls("markup_mcp_ticks").map(([, args]) => (args as { scheduleTargetId: string }).scheduleTargetId));
    expect(asked).toEqual(new Set(["s1", "s2"]));
  });

  it("Approve all removes every ticked mark and nothing else", async () => {
    mocks.loadLayer.mockResolvedValue({ layer: addMark(LAYER, 1, SIZE, { kind: "text", color: "black", at: [300, 300], size: 12, text: "keep" }), fingerprint: { size: 9_000, modified: 1_790_000_000 }, saved: 1 });
    render(<Harness />);
    const round = await submitted();
    ticks = [{ round, page: 1, mark: 1 }, { round, page: 1, mark: 2 }, { round: "other", page: 1, mark: 3 }];
    ring();
    expect(await screen.findByText("2 done")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve all" }));
    await waitFor(() => expect(lastSaved()?.sent?.pages[1].marks).toEqual([{ kind: "text", color: "black", at: [300, 300], size: 12, text: "keep" }]));
    expect(screen.queryByText(/done$/)).toBeNull();
  });

  it("shows no badge while the sent marks are hidden", async () => {
    render(<Harness />);
    const round = await submitted();
    ticks = [{ round, page: 1, mark: 1 }];
    ring();
    await waitFor(() => expect(badges()).toHaveLength(1));
    fireEvent.click(screen.getByRole("checkbox", { name: "Show sent marks" }));
    expect(badges()).toHaveLength(0);
    expect(screen.queryByText("1 done")).toBeNull();
  });

  it("tolerates a backend without the ticks command", async () => {
    ticks = "missing";
    render(<Harness />);
    await submitted();
    ring();
    await waitFor(() => expect(calls("markup_mcp_ticks").length).toBeGreaterThan(1));
    expect(badges()).toHaveLength(0);
    expect(screen.getByText("Sent — waiting for the agent")).toBeTruthy();
  });

  it("forgets an undone apply round: its ticks show nothing, the marks stay", async () => {
    submitMode = { mode: "apply", undo: UNDO_ID };
    const onReload = vi.fn();
    render(<Harness onReload={onReload} />);
    const round = await submitted();
    ticks = [{ round, page: 1, mark: 1 }];
    ring();
    await waitFor(() => expect(badges()).toHaveLength(1));
    act(() => useActivityStore.setState({ busyByTab: { "p1:t1": true }, attentionByTab: {} }));
    await screen.findByText("Agent is working…");
    act(() => useActivityStore.setState({ busyByTab: {}, attentionByTab: {} }));
    await screen.findByText(/^Agent finished/, undefined, { timeout: SETTLE_MS + 2_000 });
    fireEvent.click(screen.getByRole("button", { name: "Undo the agent's changes from this round" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(onReload).toHaveBeenCalled());
    await waitFor(() => expect(badges()).toHaveLength(0));
    expect(lastSaved()?.sent?.pages[1].marks).toEqual([STROKE, BOX]);
    expect(lastSaved()?.sent).not.toHaveProperty("log");
  }, SETTLE_MS + 8_000);
});
