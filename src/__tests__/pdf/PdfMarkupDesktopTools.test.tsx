/**
 * The desktop markup strip's second round of tools (`docs/markup_tools_plan.md`):
 * text marks snapped to the page's words, stamps, shape snapping on a held
 * stroke, note colours, the select tool (move, recolour, delete, comment),
 * presets, the undo history kept with the stored layer, the words each mark
 * was on logged at Submit, and a ✓ group's before/after caption.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  queuePromptForTab: vi.fn(),
  holdPhonePrompt: vi.fn(),
  loadLayer: vi.fn(),
  saveLayer: vi.fn(async () => true),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../../stores/agents/agentPrompts", () => ({ queuePromptForTab: mocks.queuePromptForTab }));
vi.mock("../../lib/agents/phoneHolds", () => ({ holdPhonePrompt: mocks.holdPhonePrompt }));
vi.mock("../../../mobile-web/src/markup/store", async (original) => ({
  ...(await original<typeof import("../../../mobile-web/src/markup/store")>()),
  loadLayer: mocks.loadLayer,
  saveLayer: mocks.saveLayer,
}));
vi.mock("../../components/embed/pdf/markupPage", async (original) => {
  const real = await original<typeof import("../../components/embed/pdf/markupPage")>();
  return { ...real, markupPagePicture: vi.fn(async () => ({ png: new Blob(["png"], { type: "image/png" }), composed: false, anchors: [] })) };
});

import { PdfMarkupBar } from "../../components/embed/pdf/PdfMarkupBar";
import { PdfMarkupLayer } from "../../components/embed/pdf/PdfMarkupLayer";
import { PdfTickBadges, tickBadgesByPage, tickCaption } from "../../components/embed/pdf/PdfMarkupTicks";
import { markupPagePicture } from "../../components/embed/pdf/markupPage";
import { usePdfMarkup, type MarkupEdit } from "../../components/embed/pdf/usePdfMarkup";
import { useActivityStore } from "../../stores/activity";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { textMarks } from "../../../mobile-web/src/markup/anchors";
import type { TextRun } from "../../../mobile-web/src/markup/findText";
import {
  addMark,
  EMPTY_LAYER,
  stampSize,
  type BoxMark,
  type InkMark,
  type Layer,
  type StampMark,
  type TickGroup,
} from "../../../mobile-web/src/markup/layer";
import { DEFAULT_PEN_PREFS, strokeWidth } from "../../../mobile-web/src/markup/pen";

const PATH = "/home/u/paper/paper.pdf";
const SIZE: [number, number] = [600, 800];
const BOX: BoxMark = { kind: "box", color: "yellow", rect: [100, 100, 50, 50] };
const STROKE: InkMark = { kind: "ink", color: "red", width: 2, points: [[300, 400, 0.5], [400, 400, 0.5]] };
const LAYER = addMark(addMark(EMPTY_LAYER, 1, SIZE, BOX), 1, SIZE, STROKE);
/** One line of text: "Hello world" at y 100–112. */
const RUNS: TextRun[] = [{ str: "Hello world", x: 100, y: 100, w: 110, h: 12, eol: true }];

function stubEdit(over: Partial<MarkupEdit> = {}, base: Layer = EMPTY_LAYER): MarkupEdit {
  return {
    layer: base,
    base,
    showSent: true,
    tool: "ink",
    color: "red",
    pen: DEFAULT_PEN_PREFS,
    busy: false,
    note: null,
    add: vi.fn(() => true),
    addAll: vi.fn(() => true),
    scratch: vi.fn(),
    commit: vi.fn(),
    openNote: vi.fn(),
    editNote: vi.fn(),
    editNoteColor: vi.fn(),
    saveNote: vi.fn(),
    cancelNote: vi.fn(),
    text: () => undefined,
    wantText: vi.fn(),
    selection: null,
    select: vi.fn(),
    clearSelection: vi.fn(),
    commitSelection: vi.fn(),
    comment: null,
    editComment: vi.fn(),
    saveComment: vi.fn(),
    cancelComment: vi.fn(),
    ...over,
  };
}

function mount(edit: MarkupEdit) {
  const { container } = render(<PdfMarkupLayer n={1} size={SIZE} scale={1} edit={edit} />);
  return container.querySelector(".file-viewer-pdf-markup-layer") as HTMLDivElement;
}

const down = (el: Element, x: number, y: number, extra: object = {}) =>
  fireEvent.pointerDown(el, { pointerId: 1, pointerType: "mouse", button: 0, clientX: x, clientY: y, ...extra });
const move = (el: Element, x: number, y: number) => fireEvent.pointerMove(el, { pointerId: 1, pointerType: "mouse", clientX: x, clientY: y });
const up = (el: Element, x: number, y: number) => fireEvent.pointerUp(el, { pointerId: 1, pointerType: "mouse", clientX: x, clientY: y });
const called = <T,>(fn: unknown, call = 0, arg = 0) => (fn as ReturnType<typeof vi.fn>).mock.calls[call][arg] as T;

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  // Every layer laid out at the page's own size, at the origin.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, width: SIZE[0], height: SIZE[1], right: SIZE[0], bottom: SIZE[1], x: 0, y: 0, toJSON() {},
  } as DOMRect);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("the layer's new gestures", () => {
  it("marks the words a text-mark drag crosses, as one undo step", () => {
    const edit = stubEdit({ tool: "textmark", color: "yellow", text: () => RUNS });
    const layer = mount(edit);
    down(layer, 102, 106);
    expect(edit.wantText).toHaveBeenCalledWith(1);
    move(layer, 150, 106);
    up(layer, 205, 106);
    const width = strokeWidth(SIZE[0], { size: DEFAULT_PEN_PREFS.size, style: "pen" });
    const expected = textMarks(RUNS, [102, 106], [205, 106], "highlight", "yellow", width);
    expect(expected.length).toBeGreaterThan(0);
    expect(edit.addAll).toHaveBeenCalledWith(1, SIZE, expected);
    expect(expected[0].kind).toBe("box");
  });

  it("adds nothing for a text-mark drag on a page whose words are not read yet", () => {
    const edit = stubEdit({ tool: "textmark" });
    const layer = mount(edit);
    down(layer, 102, 106);
    up(layer, 205, 106);
    expect(edit.addAll).toHaveBeenCalledWith(1, SIZE, []);
  });

  it("places a stamp where the click lands, sized to the page", () => {
    const edit = stubEdit({ tool: "stamp", color: "blue", pen: { ...DEFAULT_PEN_PREFS, tool: "stamp", stamp: "paragraph" } });
    const layer = mount(edit);
    down(layer, 200, 300);
    up(layer, 210, 305);
    expect(called<StampMark>(edit.add, 0, 2)).toEqual({ kind: "stamp", color: "blue", at: [210, 305], size: stampSize(SIZE[0]), symbol: "paragraph" });
  });

  it("straightens a stroke held still at its end", () => {
    vi.useFakeTimers();
    const edit = stubEdit();
    const layer = mount(edit);
    down(layer, 100, 100);
    for (let x = 110; x <= 300; x += 10) move(layer, x, 100 + (x % 20 === 0 ? 1.5 : -1.5));
    act(() => vi.advanceTimersByTime(600));
    up(layer, 300, 101);
    const mark = called<InkMark>(edit.add, 0, 2);
    expect(mark.points).toHaveLength(2);
    expect(mark.points[0].slice(0, 2)).toEqual([100, 100]);
  });

  it("keeps a stroke as drawn when it is not held, or snapping is off", () => {
    vi.useFakeTimers();
    for (const snap of [true, false]) {
      const edit = stubEdit({ pen: { ...DEFAULT_PEN_PREFS, snap } });
      const layer = mount(edit);
      down(layer, 100, 100);
      for (let x = 110; x <= 300; x += 10) move(layer, x, 100 + (x % 20 === 0 ? 8 : -8));
      if (!snap) act(() => vi.advanceTimersByTime(600));
      up(layer, 300, 108);
      expect(called<InkMark>(edit.add, 0, 2).points.length).toBeGreaterThan(2);
      cleanup();
    }
  });

  it("bends only a real pen's pressure by the curve", () => {
    const edit = stubEdit({ pen: { ...DEFAULT_PEN_PREFS, pressure: "light" } });
    const layer = mount(edit);
    down(layer, 100, 100, { pointerType: "pen", pressure: 0.25 });
    fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "pen", clientX: 100, clientY: 100 });
    expect(called<InkMark>(edit.add, 0, 2).points[0][2]).toBeCloseTo(0.25 ** 0.6, 1);
    down(layer, 100, 100);
    up(layer, 100, 100);
    // A mouse draws at the even base width, whatever the curve.
    expect(called<InkMark>(edit.add, 1, 2).points[0][2]).toBe(0.5);
  });

  it("selects the mark under a click, a box of marks, and moves a selection in one step", () => {
    const edit = stubEdit({ tool: "select" }, LAYER);
    const layer = mount(edit);
    down(layer, 120, 120);
    up(layer, 120, 120);
    expect(edit.select).toHaveBeenLastCalledWith(1, [0]);
    down(layer, 50, 50);
    move(layer, 450, 450);
    up(layer, 450, 450);
    expect(edit.select).toHaveBeenLastCalledWith(1, [0, 1]);
    down(layer, 500, 50);
    up(layer, 500, 50);
    expect(edit.clearSelection).toHaveBeenCalled();
    cleanup();

    const selected = stubEdit({ tool: "select", selection: { n: 1, indices: [0] } }, LAYER);
    const again = mount(selected);
    down(again, 120, 120);
    move(again, 150, 130);
    up(again, 170, 140);
    expect(selected.scratch).toHaveBeenCalled();
    const next = called<Layer>(selected.commitSelection);
    expect(next.pages[1].marks[0]).toEqual({ ...BOX, rect: [150, 120, 50, 50] });
    expect(next.pages[1].marks[1]).toBe(STROKE);
  });

  it("changes a note's colour from its card", () => {
    const edit = stubEdit({
      tool: "text",
      note: { n: 1, pageSize: SIZE, at: [50, 50], index: null, text: "teh", color: "red", size: 15 },
    });
    mount(edit);
    expect(screen.getByRole("button", { name: "Colour: Red" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Colour: Yellow" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Colour: Blue" }));
    expect(edit.editNoteColor).toHaveBeenCalledWith("blue");
  });
});

function agentTab(key: string, scheduleTargetId: string, label: string): TabEntry {
  return { key, label, cmd: "claude", cwd: "/home/u/paper", kind: "agent", scheduleTargetId } as TabEntry;
}

/** The real hook under the strip and page 1's layer. */
function Harness() {
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
  return (
    <>
      <PdfMarkupBar markup={markup} page={1} onReload={() => {}} onDone={() => {}} />
      <PdfMarkupLayer n={1} size={SIZE} scale={1} edit={markup.edit} />
    </>
  );
}

const submitButton = () => screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
const pressed = (name: string) => screen.getByRole("button", { name }).getAttribute("aria-pressed");
const lastSaved = (): Layer | undefined => {
  const calls = mocks.saveLayer.mock.calls as unknown as [string, Layer][];
  return calls[calls.length - 1]?.[1];
};
const pageLayer = () => document.querySelector(".file-viewer-pdf-markup-layer") as HTMLDivElement;

describe("the strip's new tools over the real hook", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "file_mtime") return 1_790_000_000;
      if (command === "pdf_markup_submit") return { prompt: "Look at the marked copy." };
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

  it("selects, recolours, moves and deletes marks — each one undo step", async () => {
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(screen.getByText("Click a mark or drag a box around marks · drag the selection to move it")).toBeTruthy();
    down(pageLayer(), 120, 120);
    up(pageLayer(), 120, 120);
    expect(await screen.findByText("1 selected")).toBeTruthy();
    // A box may wear yellow: four colours, the box's own pressed.
    expect(pressed("Colour: Yellow")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Colour: Blue" }));
    await waitFor(() => expect(lastSaved()?.pages[1].marks[0]).toEqual({ ...BOX, color: "blue" }));
    expect(screen.getByText("1 selected")).toBeTruthy();
    // Dragged by its outline.
    down(pageLayer(), 120, 120);
    move(pageLayer(), 140, 130);
    up(pageLayer(), 160, 140);
    await waitFor(() => expect(lastSaved()?.pages[1].marks[0]).toEqual({ ...BOX, color: "blue", rect: [140, 120, 50, 50] }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(lastSaved()?.pages[1].marks).toEqual([STROKE]));
    expect(screen.queryByText("1 selected")).toBeNull();
    // Undo walks back one step at a time; the selection is gone with it.
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(lastSaved()?.pages[1].marks[0]).toEqual({ ...BOX, color: "blue", rect: [140, 120, 50, 50] }));
    expect(screen.queryByText("1 selected")).toBeNull();
  });

  it("restyles a selected stroke and comments on it", async () => {
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    down(pageLayer(), 350, 400);
    up(pageLayer(), 350, 400);
    expect(await screen.findByText("1 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dashed" }));
    await waitFor(() => expect(lastSaved()?.pages[1].marks[1]).toEqual({ ...STROKE, style: "dashed" }));
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    const box = screen.getByPlaceholderText("What should change here?");
    fireEvent.change(box, { target: { value: "  make this\nbold  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(lastSaved()?.pages[1].marks[1]).toEqual({ ...STROKE, style: "dashed", comment: "make this bold" }));
    // Still selected: the comment opens again with its words, and goes.
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    expect((screen.getByPlaceholderText("What should change here?") as HTMLTextAreaElement).value).toBe("make this bold");
    fireEvent.click(screen.getByRole("button", { name: "Remove comment" }));
    await waitFor(() => expect(lastSaved()?.pages[1].marks[1]).toEqual({ ...STROKE, style: "dashed" }));
  });

  it("arms a preset from its chip", async () => {
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Preset 2" }));
    expect(pressed("Pen")).toBe("true");
    expect(pressed("Marker")).toBe("true");
    expect(pressed("Colour: Yellow")).toBe("true");
    expect(pressed("Preset 2")).toBe("true");
    // Save as preset keeps a fifth pen by dropping the oldest.
    fireEvent.click(screen.getByRole("button", { name: "Highlighter" }));
    fireEvent.click(screen.getByRole("button", { name: "Colour: Red" }));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Save as preset/ }));
    expect(pressed("Preset 4")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Reset presets/ }));
    expect(pressed("Preset 4")).toBe("false");
  });

  it("switches snapping and steps the pressure curve in the ⋯ menu", async () => {
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const snap = screen.getByRole("menuitemcheckbox", { name: /Straighten a held stroke/ });
    expect(snap.getAttribute("aria-checked")).toBe("true");
    const pressure = screen.getByRole("menuitem", { name: /Pen pressure/ });
    expect(pressure.textContent).toContain("Normal");
    fireEvent.click(pressure);
    expect(screen.getByRole("menuitem", { name: /Pen pressure/ }).textContent).toContain("Firm");
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Straighten a held stroke/ }));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitemcheckbox", { name: /Straighten a held stroke/ }).getAttribute("aria-checked")).toBe("false");
  });

  it("offers the stamp's symbols and the text marks' modes, with their hints", async () => {
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Stamp" }));
    expect(screen.getByText("Tap where the stamp goes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Swap" }));
    expect(pressed("Swap")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Mark text" }));
    expect(pressed("Highlight")).toBe("true");
    expect(screen.getByText("Drag across words — the marks snap to the lines")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Underline" }));
    expect(pressed("Underline")).toBe("true");
    // Underlining draws in ink: no yellow.
    expect(screen.queryByRole("button", { name: "Colour: Yellow" })).toBeNull();
  });

  it("brings the stored undo steps back and stores them with each change", async () => {
    mocks.loadLayer.mockResolvedValue({ layer: LAYER, fingerprint: { size: 9_000, modified: 1_790_000_000 }, saved: 1, past: [EMPTY_LAYER] });
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    const undo = screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement;
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo);
    await waitFor(() => expect(lastSaved()).toEqual(EMPTY_LAYER));
    // Redo puts the layer back, saved with the step before it.
    fireEvent.click(screen.getByRole("button", { name: "Redo" }));
    await waitFor(() => expect(lastSaved()).toBe(LAYER));
    const calls = mocks.saveLayer.mock.calls as unknown as [string, Layer, unknown, unknown, Layer[]][];
    expect(calls[calls.length - 1][4]).toEqual([EMPTY_LAYER]);
  });

  it("logs the words each mark was on with the round", async () => {
    vi.mocked(markupPagePicture).mockResolvedValueOnce({
      png: new Blob(["png"], { type: "image/png" }),
      composed: true,
      anchors: [],
      words: ["teh", null],
    });
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.holdPhonePrompt).toHaveBeenCalled());
    await waitFor(() => expect(lastSaved()?.sent?.log?.[0].words).toEqual({ 1: ["teh", null] }));
  });
});

describe("a ✓ group's before/after caption", () => {
  const word = (str: string): TextRun[] => [{ str, x: 100, y: 100, w: 30, h: 12, eol: true }];
  const mark: BoxMark = { kind: "box", color: "yellow", rect: [98, 99, 34, 14] };
  const sentLayer = (words?: (string | null)[]): Layer => ({
    pages: {},
    sent: { pages: { 1: { size: SIZE, marks: [mark] } }, rounds: 1, log: [{ id: "r1", pages: { 1: [mark] }, ...(words ? { words: { 1: words } } : {}) }] },
  });
  const group: TickGroup = { page: 1, marks: [{ page: 1, index: 0, round: "r1" }], box: [98, 99, 34, 14] };

  it("says what the words were and are, only when both are read and differ", () => {
    expect(tickCaption(sentLayer(["teh"]), group, word("the"))).toEqual({ before: "teh", after: "the" });
    expect(tickCaption(sentLayer(["teh"]), group, word("teh"))).toBeNull();
    expect(tickCaption(sentLayer(["teh"]), group, undefined)).toBeNull();
    expect(tickCaption(sentLayer([null]), group, word("the"))).toBeNull();
    expect(tickCaption(sentLayer(), group, word("the"))).toBeNull();
  });

  it("shows the caption beside the badge", () => {
    const layer = sentLayer(["teh"]);
    const caption = tickCaption(layer, group, word("the"))!;
    const badges = tickBadgesByPage(layer, [group], new Map([[group, caption]])).get(1)!;
    render(<PdfTickBadges badges={badges} size={SIZE} scale={1} disabled={false} onApprove={() => {}} />);
    expect(screen.getByText("Was “teh” · now “the”")).toBeTruthy();
    expect(screen.getByRole("button", { name: /approve/ })).toBeTruthy();
  });
});
