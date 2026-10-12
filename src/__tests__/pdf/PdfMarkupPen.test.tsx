/**
 * The pen bar (`mobile-web/src/markup/pen.ts`) and what it draws: a colour per
 * tool with yellow kept to the highlighters, pen styles and sizes, the area
 * eraser (`eraseRect`) and the arrow's head — shared by the phone and the
 * desktop strip — and the desktop layer's gestures for them.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfMarkupLayer } from "../../components/embed/pdf/PdfMarkupLayer";
import type { MarkupEdit } from "../../components/embed/pdf/usePdfMarkup";
import {
  addMark,
  arrowHead,
  cutStroke,
  EMPTY_LAYER,
  eraseRect,
  isLayer,
  type InkMark,
  type Layer,
} from "../../../mobile-web/src/markup/layer";
import {
  colorOf,
  colorsFor,
  DEFAULT_PEN_PREFS,
  nextStyle,
  parsePenPrefs,
  penCursor,
  readPenPrefs,
  stepSize,
  strokePressure,
  strokeWidth,
  withColor,
  writePenPrefs,
  type PenPrefs,
} from "../../../mobile-web/src/markup/pen";
import { drawMark, type Paint } from "../../../mobile-web/src/markup/rasterize";

const SIZE: [number, number] = [600, 800];
const line = (x0: number, x1: number, y: number, extra: Partial<InkMark> = {}): InkMark => ({
  kind: "ink",
  color: "red",
  width: 2,
  points: [[x0, y, 0.5], [(x0 + x1) / 2, y, 0.5], [x1, y, 0.5]],
  ...extra,
});

describe("pen prefs", () => {
  it("remembers a colour per tool and offers yellow only to the highlighters", () => {
    expect(colorsFor("box", "pen")).toContain("yellow");
    expect(colorsFor("ink", "marker")).toContain("yellow");
    expect(colorsFor("ink", "pen")).not.toContain("yellow");
    expect(colorsFor("text", "pen")).not.toContain("yellow");
    let prefs: PenPrefs = { ...DEFAULT_PEN_PREFS, tool: "ink", style: "marker" };
    prefs = withColor(prefs, "yellow");
    expect(colorOf(prefs)).toBe("yellow");
    // The pen can't draw yellow: it falls back, and the marker gets it back.
    expect(colorOf({ ...prefs, style: "pen" })).toBe("red");
    expect(colorOf({ ...prefs, style: "marker" })).toBe("yellow");
    // The box keeps its own.
    expect(colorOf({ ...prefs, tool: "box" })).toBe("yellow");
    prefs = withColor({ ...prefs, tool: "text" }, "blue");
    expect(colorOf(prefs, "text")).toBe("blue");
    expect(colorOf(prefs, "ink")).toBe("yellow");
  });

  it("parses a stored record field by field and falls back on the rest", () => {
    expect(parsePenPrefs(null)).toEqual(DEFAULT_PEN_PREFS);
    expect(parsePenPrefs({ tool: "laser", size: 7, style: "arrow", colors: { ink: "pink", box: "red" }, eraser: "area" })).toEqual({
      ...DEFAULT_PEN_PREFS,
      style: "arrow",
      colors: { ...DEFAULT_PEN_PREFS.colors, box: "red" },
      eraser: "area",
    });
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const mine: PenPrefs = { ...DEFAULT_PEN_PREFS, tool: "eraser", size: 2, eraser: "large" };
    writePenPrefs(mine, storage);
    expect(readPenPrefs(storage)).toEqual(mine);
    expect(readPenPrefs({ getItem: () => "{not json", setItem: () => {} })).toEqual(DEFAULT_PEN_PREFS);
  });

  it("sizes strokes by page width, size and style, and steps the size or the eraser's reach", () => {
    expect(strokeWidth(700, { size: 1, style: "pen" })).toBe(2);
    expect(strokeWidth(700, { size: 0, style: "pen" })).toBeLessThan(2);
    expect(strokeWidth(700, { size: 2, style: "pen" })).toBeGreaterThan(2);
    expect(strokeWidth(700, { size: 1, style: "marker" })).toBe(10);
    expect(strokeWidth(1e6, { size: 2, style: "marker" })).toBe(100);
    expect(strokePressure("pen", 0.9)).toBe(0.9);
    expect(strokePressure("dashed", 0.9)).toBe(0.5);
    expect(stepSize({ ...DEFAULT_PEN_PREFS, size: 2 }, 1).size).toBe(2);
    expect(stepSize({ ...DEFAULT_PEN_PREFS, size: 1 }, -1).size).toBe(0);
    expect(stepSize({ ...DEFAULT_PEN_PREFS, tool: "eraser", eraser: "medium" }, 1).eraser).toBe("large");
    expect(stepSize({ ...DEFAULT_PEN_PREFS, tool: "eraser", eraser: "area" }, 1).eraser).toBe("area");
    expect(nextStyle("pen")).toBe("marker");
    expect(nextStyle("arrow")).toBe("pen");
  });

  it("draws a cursor no larger than browsers take", () => {
    expect(penCursor("dot", 500, "#db2626")).toMatch(/^url\("data:image\/svg\+xml,.*width%3D%22124%22.*"\) 62 62, crosshair$/);
  });
});

describe("pen styles and the area eraser", () => {
  it("points an arrow's head back along its last stretch", () => {
    const head = arrowHead([[0, 0, 0.5], [100, 0, 0.5]], 2)!;
    expect(head[1]).toEqual([100, 0]);
    expect(head[0][0]).toBeLessThan(100);
    expect(head[0][1]).toBeCloseTo(-head[2][1]);
    expect(arrowHead([[5, 5, 0.5]], 2)).toBeNull();
    expect(arrowHead([[5, 5, 0.5], [5, 5, 0.5]], 2)).toBeNull();
  });

  it("keeps a style through storage, and refuses one it does not know", () => {
    const layer = addMark(EMPTY_LAYER, 1, SIZE, line(10, 90, 50, { style: "dashed" }));
    expect(isLayer(JSON.parse(JSON.stringify(layer)))).toBe(true);
    const bad = JSON.parse(JSON.stringify(layer));
    bad.pages[1].marks[0].style = "laser";
    expect(isLayer(bad)).toBe(false);
  });

  it("cuts an arrow so only the run that still ends where it did keeps the head", () => {
    const runs = cutStroke(line(0, 200, 50, { style: "arrow" }), 100, 50, 5)!;
    expect(runs).toHaveLength(2);
    expect(runs[0].style).toBeUndefined();
    expect(runs[1].style).toBe("arrow");
  });

  it("erases an area: strokes cut at its edge, boxes and notes it overlaps whole, sent marks when asked", () => {
    let layer: Layer = addMark(EMPTY_LAYER, 1, SIZE, line(0, 300, 100));
    layer = addMark(layer, 1, SIZE, { kind: "box", color: "yellow", rect: [140, 300, 40, 20] });
    layer = addMark(layer, 1, SIZE, { kind: "text", color: "blue", at: [400, 600], size: 12, text: "far away" });
    const next = eraseRect(layer, 1, [100, 80], [200, 400]);
    const marks = next.pages[1].marks;
    expect(marks.map((mark) => mark.kind)).toEqual(["ink", "ink", "text"]);
    const [left, right] = marks as InkMark[];
    // The half width (inkWidth(2, 1) / 2 = 1.7) is taken off at either edge too.
    expect(left.points[left.points.length - 1][0]).toBeCloseTo(98.3, 1);
    expect(right.points[0][0]).toBeCloseTo(201.7, 1);
    // Dragged the other way round, the same rectangle.
    expect(eraseRect(layer, 1, [200, 400], [100, 80])).toEqual(next);
    // A miss changes nothing — the same object, so no undo step.
    expect(eraseRect(layer, 1, [500, 10], [520, 20])).toBe(layer);
    const sent: Layer = { pages: {}, sent: { pages: { 1: { size: SIZE, marks: [line(0, 300, 100)] } }, rounds: 1 } };
    expect(eraseRect(sent, 1, [100, 80], [200, 400])).toBe(sent);
    expect(eraseRect(sent, 1, [100, 80], [200, 400], true).sent!.pages[1].marks).toHaveLength(2);
  });

  it("draws a styled stroke as one path — dashed, see-through or headed", () => {
    const calls: string[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (target, key: string) => (key in target ? target[key] : (...args: unknown[]) => calls.push(`${key}(${args.join(",")})`)),
      set: (target, key: string, value) => {
        target[key] = value;
        return true;
      },
    }) as unknown as Paint & Record<string, unknown>;
    ctx.globalAlpha = 1;
    drawMark(ctx, line(0, 100, 10, { style: "dashed" }));
    expect(calls.filter((c) => c.startsWith("stroke(")).length).toBe(1);
    expect(calls).toContain("setLineDash(5,7)");
    calls.length = 0;
    drawMark(ctx, line(0, 100, 10, { style: "arrow" }));
    expect(calls.filter((c) => c.startsWith("stroke(")).length).toBe(2);
    calls.length = 0;
    drawMark(ctx, line(0, 100, 10));
    // The plain pen: a piece per sample at its own width.
    expect(calls.filter((c) => c.startsWith("stroke(")).length).toBe(3);
  });
});

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
    scratch: vi.fn(),
    commit: vi.fn(),
    openNote: vi.fn(),
    editNote: vi.fn(),
    saveNote: vi.fn(),
    cancelNote: vi.fn(),
    addAll: vi.fn(() => true),
    editNoteColor: vi.fn(),
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
  const layer = container.querySelector(".file-viewer-pdf-markup-layer") as HTMLDivElement;
  layer.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: SIZE[0], height: SIZE[1], right: 0, bottom: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return layer;
}

describe("PdfMarkupLayer pen bar gestures", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("draws a marker stroke wide and even, whatever the pen's pressure", () => {
    const edit = stubEdit({ pen: { ...DEFAULT_PEN_PREFS, style: "marker", size: 2 }, color: "yellow" });
    const layer = mount(edit);
    fireEvent.pointerDown(layer, { pointerId: 1, pointerType: "pen", button: 0, pressure: 0.9, clientX: 50, clientY: 60 });
    fireEvent.pointerMove(layer, { pointerId: 1, pointerType: "pen", pressure: 0.2, clientX: 150, clientY: 60 });
    fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "pen", clientX: 150, clientY: 60 });
    const mark = (edit.add as ReturnType<typeof vi.fn>).mock.calls[0][2] as InkMark;
    expect(mark).toMatchObject({ kind: "ink", color: "yellow", style: "marker", width: strokeWidth(SIZE[0], { size: 2, style: "marker" }) });
    expect(mark.points.every((p) => p[2] === 0.5)).toBe(true);
  });

  it("leaves the plain pen's stroke without a style field", () => {
    const edit = stubEdit();
    const layer = mount(edit);
    fireEvent.pointerDown(layer, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 50, clientY: 60 });
    fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "mouse", clientX: 90, clientY: 60 });
    expect("style" in (edit.add as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe(false);
  });

  it("erases a dragged area in one undo step", () => {
    const base = addMark(addMark(EMPTY_LAYER, 1, SIZE, { kind: "box", color: "yellow", rect: [100, 100, 50, 50] }), 1, SIZE, {
      kind: "box",
      color: "red",
      rect: [400, 400, 50, 50],
    });
    const edit = stubEdit({ tool: "eraser", pen: { ...DEFAULT_PEN_PREFS, tool: "eraser", eraser: "area" } }, base);
    const layer = mount(edit);
    expect(layer.className).toContain("is-area");
    fireEvent.pointerDown(layer, { pointerId: 1, pointerType: "mouse", button: 0, clientX: 90, clientY: 90 });
    fireEvent.pointerMove(layer, { pointerId: 1, pointerType: "mouse", clientX: 200, clientY: 200 });
    fireEvent.pointerUp(layer, { pointerId: 1, pointerType: "mouse", clientX: 200, clientY: 200 });
    expect(edit.commit).toHaveBeenCalledTimes(1);
    expect((edit.commit as ReturnType<typeof vi.fn>).mock.calls[0][0].pages[1].marks).toEqual([base.pages[1].marks[1]]);
  });

  it("shows the pen's colour and width as the cursor", () => {
    const layer = mount(stubEdit({ color: "blue" }));
    expect(layer.style.cursor).toContain(encodeURIComponent("#2663eb"));
  });
});
