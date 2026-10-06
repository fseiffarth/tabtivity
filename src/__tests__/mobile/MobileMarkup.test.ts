/**
 * The markup layer's pure helpers (`mobile-web/src/markup/`): marks in page
 * units with undo, the phone-only store that never throws, the one drawing
 * routine, and the check every message from the sealed pdf.js frame passes.
 */
import { describe, expect, it } from "vitest";

import {
  acceptFrameMessage, acceptToFrame, MAX_RENDER_WIDTH,
} from "../../../mobile-web/src/markup/frameProtocol";
import {
  addMark, canAdd, canReplace, clearAll, clearPage, commit, cutStroke, EMPTY_LAYER, eraseAlong, eraseAt, finishStroke, inkWidth, isEmpty, isLayer, LIMITS, markAnchors, markedPages,
  markSent, moveNote, noteAt, redo, replaceMark, simplify, startHistory, stylusErases, undo, type InkMark, type Layer, type Mark, type TextMark,
} from "../../../mobile-web/src/markup/layer";
import { drawPage, strokePieces, type Paint } from "../../../mobile-web/src/markup/rasterize";
import { clearLayer, layerKey, loadLayer, saveLayer, stale, type LayerBackend } from "../../../mobile-web/src/markup/store";

const SIZE: [number, number] = [612, 792];
const ink = (points: [number, number, number][], color: InkMark["color"] = "red"): InkMark => ({ kind: "ink", color, width: 2, points });

describe("markup layer", () => {
  it("keeps marks per page and undoes and redoes whole changes", () => {
    let history = startHistory();
    history = commit(history, addMark(history.present, 3, SIZE, ink([[10, 10, 0.5], [20, 20, 0.5]])));
    history = commit(history, addMark(history.present, 1, SIZE, { kind: "box", color: "yellow", rect: [5, 5, 50, 10] }));
    expect(markedPages(history.present)).toEqual([1, 3]);
    history = undo(history);
    expect(markedPages(history.present)).toEqual([3]);
    history = redo(history);
    expect(markedPages(history.present)).toEqual([1, 3]);
    history = commit(history, clearPage(history.present, 3));
    expect(markedPages(history.present)).toEqual([1]);
    expect(history.present.pages[3]).toBeUndefined();
    // A new change drops what could have been redone.
    history = undo(history);
    history = commit(history, addMark(history.present, 2, SIZE, ink([[1, 1, 0.5]])));
    expect(history.future).toEqual([]);
    expect(isEmpty(EMPTY_LAYER)).toBe(true);
  });

  it("clears every page at once — the sent marks too only when asked — as one undoable step", () => {
    let layer: Layer = addMark(EMPTY_LAYER, 1, SIZE, ink([[10, 10, 0.5], [20, 20, 0.5]]));
    layer = markSent(layer);
    layer = addMark(layer, 2, SIZE, { kind: "box", color: "yellow", rect: [5, 5, 50, 10] });
    layer = addMark(layer, 4, SIZE, ink([[1, 1, 0.5]]));
    const pending = clearAll(layer);
    expect(markedPages(pending)).toEqual([]);
    expect(pending.sent).toEqual(layer.sent);
    const all = clearAll(layer, true);
    expect(markedPages(all)).toEqual([]);
    expect(all.sent?.pages).toEqual({});
    // Nothing to clear: the same layer, so the history takes no empty step.
    expect(clearAll(EMPTY_LAYER, true)).toBe(EMPTY_LAYER);
    expect(clearAll(pending)).toBe(pending);
    let history = commit(startHistory(), layer);
    history = commit(history, clearAll(history.present, true));
    expect(undo(history).present).toBe(layer);
  });

  it("lists every shown mark's top in reading order, sent ones only when shown", () => {
    let layer: Layer = addMark(EMPTY_LAYER, 3, SIZE, ink([[10, 400, 0.5], [20, 380.5, 0.5], [30, 420, 0.5]]));
    layer = markSent(layer);
    layer = addMark(layer, 2, SIZE, { kind: "text", color: "black", at: [40, 600], size: 12, text: "late" });
    layer = addMark(layer, 2, SIZE, { kind: "box", color: "yellow", rect: [5, 120, 50, -20] });
    layer = addMark(layer, 3, SIZE, { kind: "text", color: "red", at: [5, 50], size: 12, text: "top" });
    expect(markAnchors(layer)).toEqual([{ page: 2, y: 100 }, { page: 2, y: 600 }, { page: 3, y: 50 }]);
    expect(markAnchors(layer, true)).toEqual([{ page: 2, y: 100 }, { page: 2, y: 600 }, { page: 3, y: 50 }, { page: 3, y: 380.5 }]);
    expect(markAnchors(EMPTY_LAYER, true)).toEqual([]);
  });

  it("finishes a stroke on the page, rounded and simplified", () => {
    const straight: [number, number, number][] = Array.from({ length: 50 }, (_, i) => [i * 2 + 0.123, 100.06, 0.5]);
    const done = finishStroke(ink([...straight, [700, -5, 0.9]]), SIZE);
    expect(done.points.length).toBeLessThan(10);
    expect(done.points[0]).toEqual([0.1, 100.1, 0.5]);
    expect(done.points[done.points.length - 1]).toEqual([612, 0, 0.9]);
    // A corner survives simplification.
    expect(simplify([[0, 0, 0.5], [50, 0, 0.5], [50, 50, 0.5]], 1)).toHaveLength(3);
  });

  it("erases the part of a stroke it rubs over, whole notes, and only those", () => {
    let layer: Layer = addMark(EMPTY_LAYER, 1, SIZE, ink([[10, 10, 0.5], [100, 10, 0.5]]));
    layer = addMark(layer, 1, SIZE, ink([[10, 200, 0.5], [100, 200, 0.5]], "blue"));
    layer = addMark(layer, 1, SIZE, { kind: "text", color: "black", at: [300, 300], size: 12, text: "note\nsecond line" });
    // Reach 4 + half the stroke's widest (1.7), 2 above the line: cut ±5.34 around x = 55.
    const erased = eraseAt(layer, 1, 55, 12, 4);
    expect(erased.pages[1].marks.map((m) => m.kind === "ink" ? m.color : m.kind)).toEqual(["red", "red", "blue", "text"]);
    expect((erased.pages[1].marks[0] as InkMark).points).toEqual([[10, 10, 0.5], [49.7, 10, 0.5]]);
    expect((erased.pages[1].marks[1] as InkMark).points).toEqual([[60.3, 10, 0.5], [100, 10, 0.5]]);
    expect(eraseAt(erased, 1, 310, 315, 1).pages[1].marks).toHaveLength(3);
    expect(eraseAt(layer, 1, 500, 500, 2)).toBe(layer);
    expect(replaceMark(layer, 1, 2, null).pages[1].marks).toHaveLength(2);
  });

  it("shortens a stroke at its end, takes one wholly under it, and dots", () => {
    const stroke = ink([[0, 0, 0.2], [100, 0, 0.8]]);
    // Rubbed at the end: the stroke stops at the reach, its pressure in between.
    expect(cutStroke(stroke, 100, 0, 8.3)).toEqual([ink([[0, 0, 0.2], [90, 0, 0.74]])]);
    expect(cutStroke(stroke, 50, 50, 4)).toBeNull();
    expect(cutStroke(stroke, 50, 0, 60)).toEqual([]);
    expect(cutStroke(ink([[5, 5, 0.5]]), 6, 6, 1)).toEqual([]);
    expect(cutStroke(ink([[5, 5, 0.5]]), 50, 50, 1)).toBeNull();
    // Boxes go whole, and a stroke grazed exactly at its reach is left alone.
    const box = addMark(EMPTY_LAYER, 1, SIZE, { kind: "box", color: "yellow", rect: [0, 0, 100, 10] });
    expect(eraseAt(box, 1, 50, 5, 1).pages).toEqual({});
    expect(cutStroke(stroke, 50, 5.7, 4)).toBeNull();
  });

  it("drags the eraser through a stroke even between two far samples", () => {
    // Two samples a page apart: the drag's own two points miss the ink at x = 300.
    const layer = addMark(EMPTY_LAYER, 1, SIZE, ink([[0, 300, 0.5], [600, 300, 0.5]]));
    const dragged = eraseAlong(layer, 1, [300, 100], [300, 500], 4);
    const pieces = dragged.pages[1].marks as InkMark[];
    expect(pieces).toHaveLength(2);
    expect(pieces[0].points[1][0]).toBeLessThan(300);
    expect(pieces[1].points[0][0]).toBeGreaterThan(300);
    expect(eraseAlong(layer, 1, [10, 10], [10, 10], 4)).toBe(layer);
  });

  it("takes a whole stroke when cutting it would pass the ceilings", () => {
    // The layer is at its mark ceiling; one stroke cut in two would pass it.
    const stroke = addMark(EMPTY_LAYER, 1, SIZE, ink([[0, 300, 0.5], [600, 300, 0.5]]));
    const layer: Layer = { ...stroke, pages: { ...stroke.pages, 2: { size: SIZE, marks: Array.from({ length: LIMITS.marks - 1 }, (): Mark => ink([[5, 5, 0.5]])) } } };
    expect(eraseAt(layer, 1, 300, 300, 4).pages[1]).toBeUndefined();
    // Shortened at its end, it stays one stroke and is cut.
    expect((eraseAt(layer, 1, 600, 300, 4).pages[1].marks[0] as InkMark).points[1][0]).toBeCloseTo(594.3);
  });

  it("knows a pen's eraser end", () => {
    expect(stylusErases({ pointerType: "pen", button: 5, buttons: 32 })).toBe(true);
    expect(stylusErases({ pointerType: "pen", button: -1, buttons: 32 })).toBe(true);
    expect(stylusErases({ pointerType: "pen", button: 0, buttons: 1 })).toBe(false);
    expect(stylusErases({ pointerType: "mouse", button: 5, buttons: 32 })).toBe(false);
  });

  it("finds the topmost note under a point and moves it, kept on the page", () => {
    const note: TextMark = { kind: "text", color: "black", at: [100, 100], size: 10, text: "abc" };
    let layer: Layer = addMark(EMPTY_LAYER, 1, SIZE, note);
    layer = addMark(layer, 1, SIZE, ink([[0, 0, 0.5], [600, 700, 0.5]]));
    layer = addMark(layer, 1, SIZE, { ...note, color: "red" });
    expect(noteAt(layer.pages[1], 105, 105)).toBe(2);
    expect(noteAt(layer.pages[1], 5, 5)).toBe(-1);
    expect(noteAt(undefined, 105, 105)).toBe(-1);
    expect(moveNote(note, [200.04, 300.06], SIZE).at).toEqual([200, 300.1]);
    // Past an edge, the note stops where its whole box still fits.
    expect(moveNote(note, [-50, 9_000], SIZE).at).toEqual([0, 780]);
    expect(moveNote(note, [9_000, 10], SIZE).at).toEqual([590.4, 10]);
  });

  it("refuses a mark past the desktop's ceilings", () => {
    const many: [number, number, number][] = Array.from({ length: LIMITS.points }, () => [1, 1, 0.5]);
    const full = addMark(EMPTY_LAYER, 1, SIZE, ink(many));
    expect(canAdd(full, 1, ink([[1, 1, 0.5]]))).toBe(false);
    const longNote: Mark = { kind: "text", color: "red", at: [1, 1], size: 12, text: "x".repeat(LIMITS.pageText) };
    const noted = addMark(EMPTY_LAYER, 1, SIZE, longNote);
    expect(canAdd(noted, 1, { ...longNote, text: "y" })).toBe(false);
    expect(canAdd(noted, 2, { ...longNote, text: "y" })).toBe(true);
    // An edited note counts in place of the one it replaces.
    const two = addMark(addMark(EMPTY_LAYER, 1, SIZE, { ...longNote, text: "a".repeat(1_000) }), 1, SIZE, { ...longNote, text: "b".repeat(900) });
    expect(canReplace(two, 1, 1, { ...longNote, text: "c".repeat(1_000) })).toBe(true);
    expect(canReplace(two, 1, 1, { ...longNote, text: "c".repeat(1_500) })).toBe(false);
  });

  it("draws pressure the way the desktop bakes it", () => {
    expect(inkWidth(2, 0.5)).toBeCloseTo(2);
    expect(inkWidth(2, 1)).toBeCloseTo(3.4);
    expect(inkWidth(2, 7)).toBeCloseTo(3.4);
  });

  it("accepts only stored layers this build can draw", () => {
    const good = addMark(EMPTY_LAYER, 2, SIZE, ink([[1, 2, 0.5]]));
    expect(isLayer(JSON.parse(JSON.stringify(good)))).toBe(true);
    for (const bad of [null, {}, { pages: { 0: { size: SIZE, marks: [] } } }, { pages: { 1: { size: [1], marks: [] } } },
      { pages: { 1: { size: SIZE, marks: [{ kind: "laser", color: "red" }] } } },
      { pages: { 1: { size: SIZE, marks: [{ kind: "ink", color: "pink", width: 2, points: [[1, 1, 1]] }] } } }]) {
      expect(isLayer(bad)).toBe(false);
    }
  });
});

describe("markup store", () => {
  const memory = (): LayerBackend & { map: Map<string, unknown> } => {
    const map = new Map<string, unknown>();
    return { map, get: async (k) => map.get(k), put: async (k, v) => { map.set(k, v); }, delete: async (k) => { map.delete(k); } };
  };
  const broken: LayerBackend = {
    get: () => Promise.reject(new Error("SecurityError")),
    put: () => Promise.reject(new Error("QuotaExceededError")),
    delete: () => Promise.reject(new Error("SecurityError")),
  };
  const layer = addMark(EMPTY_LAYER, 1, SIZE, ink([[1, 2, 0.5]]));

  it("saves, loads and clears one record per file", async () => {
    const backend = memory();
    const key = layerKey("p1", { outbox: "20261001-draft.pdf" });
    expect(await loadLayer(key, backend)).toBeNull();
    expect(await saveLayer(key, layer, { size: 10, modified: 20 }, backend)).toBe(true);
    const stored = await loadLayer(key, backend);
    expect(stored && stored !== "unavailable" && stored.layer).toEqual(layer);
    expect(stored !== "unavailable" && stored && stale(stored, { size: 10, modified: 21 })).toBe(true);
    // An emptied layer leaves nothing behind.
    expect(await saveLayer(key, EMPTY_LAYER, { size: 10, modified: 20 }, backend)).toBe(true);
    expect(backend.map.size).toBe(0);
    await saveLayer(key, layer, { size: 10, modified: 20 }, backend);
    expect(await clearLayer(key, backend)).toBe(true);
    expect(await loadLayer(key, backend)).toBeNull();
    expect(layerKey("p1", { files: "docs/draft.pdf" })).not.toEqual(layerKey("p2", { files: "docs/draft.pdf" }));
  });

  it("never throws when storage is unavailable", async () => {
    expect(await loadLayer("k", broken)).toBe("unavailable");
    expect(await saveLayer("k", layer, { size: 1, modified: 1 }, broken)).toBe(false);
    expect(await clearLayer("k", broken)).toBe(false);
    const garbage = memory();
    garbage.map.set("k", { layer: "not a layer", fingerprint: { size: 1, modified: 1 } });
    expect(await loadLayer("k", garbage)).toBeNull();
  });
});

describe("markup drawing", () => {
  it("curves a stroke through its midpoints, one piece per sample", () => {
    const pieces = strokePieces([[0, 0, 0.2], [10, 0, 0.5], [10, 10, 0.9]]);
    expect(pieces).toEqual([
      { from: [0, 0], to: [5, 0], pressure: 0.2 },
      { from: [5, 0], control: [10, 0], to: [10, 5], pressure: 0.5 },
      { from: [10, 5], to: [10, 10], pressure: 0.9 },
    ]);
    expect(strokePieces([[3, 4, 0.5]])).toEqual([{ from: [3, 4], to: [3, 4], pressure: 0.5 }]);
  });

  it("draws every mark kind onto a context at the given scale", () => {
    const calls: string[] = [];
    const record = (name: string) => (...args: unknown[]) => { calls.push(`${name}(${args.join(",")})`); };
    const ctx = {
      save: record("save"), restore: record("restore"), scale: record("scale"), beginPath: record("beginPath"),
      moveTo: record("moveTo"), lineTo: record("lineTo"), quadraticCurveTo: record("quad"), stroke: record("stroke"),
      fillRect: record("fillRect"), fillText: record("fillText"),
      lineWidth: 0, lineCap: "butt", lineJoin: "miter", strokeStyle: "", fillStyle: "", globalAlpha: 1, globalCompositeOperation: "source-over",
      font: "", textBaseline: "alphabetic",
    } as Paint;
    drawPage(ctx, { size: SIZE, marks: [
      ink([[0, 0, 0.5], [10, 0, 0.5], [10, 10, 0.5]]),
      { kind: "box", color: "yellow", rect: [1, 2, 3, 4] },
      { kind: "text", color: "blue", at: [5, 6], size: 10, text: "a\nb" },
    ] }, 2);
    expect(calls[1]).toBe("scale(2,2)");
    expect(calls.filter((c) => c === "stroke()")).toHaveLength(3);
    expect(calls).toContain("quad(10,0,10,5)");
    expect(calls).toContain("fillRect(1,2,3,4)");
    expect(calls).toContain("fillText(a,5,15)");
    expect(calls).toContain("fillText(b,5,27)");
  });
});

describe("sealed frame messages", () => {
  // Real windows: jsdom's MessageEvent takes nothing else as a source.
  const holder = document.createElement("iframe");
  document.body.append(holder);
  const frame = holder.contentWindow!;
  const from = (data: unknown, source: Window | null = frame, origin = "null") => new MessageEvent("message", { data, origin, source });

  it("accepts only the frame's own messages, in shape and in range", () => {
    expect(acceptFrameMessage(from({ type: "ready" }), frame)).toEqual({ type: "ready" });
    expect(acceptFrameMessage(from({ type: "meta", pages: [{ w: 612, h: 792 }] }), frame)).toEqual({ type: "meta", pages: [{ w: 612, h: 792 }] });
    expect(acceptFrameMessage(from({ type: "failed", code: "encrypted" }), frame)).toEqual({ type: "failed", code: "encrypted" });
    expect(acceptFrameMessage(from({ type: "failed", code: "render", n: 2 }), frame, 3)).toEqual({ type: "failed", code: "render", n: 2 });
  });

  it("drops forged and malformed messages", () => {
    const other = window;
    for (const event of [
      from({ type: "ready" }, other),
      from({ type: "ready" }, frame, "https://desktop.example.ts.net"),
      from({ type: "ready" }, null),
      from("ready"),
      from({ type: "html", html: "<img onerror=alert(1)>" }),
      from({ type: "meta", pages: [] }),
      from({ type: "meta", pages: [{ w: 0, h: 792 }] }),
      from({ type: "meta", pages: [{ w: "612", h: 792 }] }),
      from({ type: "meta", pages: [{ w: Infinity, h: 792 }] }),
      from({ type: "failed", code: "<b>bad</b>" }),
      from({ type: "failed", code: "render", n: 9 }),
      from({ type: "page", n: 1, width: 600, bitmap: {} }),
      from({ type: "page", n: 1.5, width: 600, bitmap: {} }),
    ]) {
      expect(acceptFrameMessage(event, frame, 3)).toBeNull();
    }
    expect(acceptFrameMessage(from({ type: "ready" }), null)).toBeNull();
  });

  it("lets the frame take only the two requests it serves", () => {
    const bytes = new ArrayBuffer(4);
    expect(acceptToFrame({ type: "open", bytes })).toEqual({ type: "open", bytes });
    expect(acceptToFrame({ type: "render", n: 2, width: 800 })).toEqual({ type: "render", n: 2, width: 800 });
    expect(acceptToFrame({ type: "render", n: 2, width: MAX_RENDER_WIDTH + 1 })).toBeNull();
    expect(acceptToFrame({ type: "open", bytes: "x" })).toBeNull();
    expect(acceptToFrame({ type: "eval", code: "1" })).toBeNull();
  });
});
