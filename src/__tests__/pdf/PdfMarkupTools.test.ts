/**
 * Markup tools, round 2 — the shared model both viewers build on
 * (`docs/markup_tools_plan.md`): proofreading stamps in every layer function,
 * selection and editing, per-mark comments, shape snapping, text marks that
 * snap to the page's lines, the before/after words a Submit logs, the pen
 * bar's new prefs (presets, pressure curve, palm rejection) and the undo steps
 * a stored record keeps.
 */
import { describe, expect, it } from "vitest";

import { anchorsFor, textMarks, wordsIn } from "../../../mobile-web/src/markup/anchors";
import type { TextRun } from "../../../mobile-web/src/markup/findText";
import {
  addMark,
  addMarks,
  canAddAll,
  cleanComment,
  commit,
  EMPTY_LAYER,
  eraseAt,
  eraseRect,
  isLayer,
  LIMITS,
  markAnchors,
  markAt,
  markBox,
  markSent,
  markSentSome,
  marksIn,
  MAX_COMMENT,
  moveMarks,
  removeMarks,
  restyleMarks,
  setComment,
  snapStroke,
  STAMP_SHAPES,
  STAMP_SYMBOLS,
  STAMP_WIDTH,
  stampSize,
  startHistory,
  undo,
  type InkMark,
  type Layer,
  type Mark,
  type PageLayer,
  type StampMark,
} from "../../../mobile-web/src/markup/layer";
import {
  applyPreset,
  colorOf,
  colorsFor,
  DEFAULT_PEN_PREFS,
  DEFAULT_PRESETS,
  MAX_PRESETS,
  palmRejects,
  parsePenPrefs,
  resetPresets,
  savePreset,
  strokePressure,
  withColor,
} from "../../../mobile-web/src/markup/pen";
import { drawMark, type Paint } from "../../../mobile-web/src/markup/rasterize";
import { loadLayer, MAX_STORED_UNDO, saveLayer, type LayerBackend } from "../../../mobile-web/src/markup/store";

const SIZE: [number, number] = [600, 800];
const stamp = (x: number, y: number, extra: Partial<StampMark> = {}): StampMark => ({ kind: "stamp", color: "red", at: [x, y], size: 20, symbol: "delete", ...extra });
const ink = (points: [number, number][], extra: Partial<InkMark> = {}): InkMark => ({
  kind: "ink",
  color: "red",
  width: 2,
  points: points.map(([x, y]): [number, number, number] => [x, y, 0.5]),
  ...extra,
});
const withMarks = (...marks: Mark[]): Layer => ({ pages: { 1: { size: SIZE, marks } } });
const marksOf = (layer: Layer, n = 1) => layer.pages[n]?.marks ?? [];

describe("stamps in the layer", () => {
  it("has a unit shape per symbol and sizes to the page", () => {
    for (const symbol of STAMP_SYMBOLS) {
      expect(STAMP_SHAPES[symbol].length).toBeGreaterThan(0);
      for (const line of STAMP_SHAPES[symbol]) for (const [x, y] of line) expect(Math.max(Math.abs(x), Math.abs(y))).toBeLessThanOrEqual(0.5);
    }
    expect(stampSize(600)).toBe(20);
    expect(stampSize(30)).toBe(4);
    expect(stampSize(50_000)).toBe(200);
  });

  it("is accepted by isLayer, with comments and logged words, and older records still are", () => {
    expect(isLayer(withMarks(stamp(10, 10), stamp(20, 20, { symbol: "swap", comment: "these two" })))).toBe(true);
    expect(isLayer(withMarks({ ...stamp(10, 10), symbol: "star" } as unknown as Mark))).toBe(false);
    expect(isLayer(withMarks({ kind: "text", color: "red", at: [1, 1], size: 12, text: "x", comment: "no" } as unknown as Mark))).toBe(false);
    expect(isLayer(withMarks(ink([[1, 1]], { comment: "x".repeat(MAX_COMMENT + 1) })))).toBe(false);
    expect(isLayer(withMarks(ink([[1, 1]], { comment: 5 as unknown as string })))).toBe(false);
    // A record from before stamps, comments and words.
    expect(isLayer({ pages: { 1: { size: SIZE, marks: [ink([[1, 1]])] } }, sent: { pages: {}, rounds: 1, log: [{ id: "abc", pages: { 1: [] } }] } })).toBe(true);
    const logged = { pages: {}, sent: { pages: {}, rounds: 1, log: [{ id: "abc", pages: { 1: [stamp(1, 1)] }, words: { 1: ["fox", null] } }] } };
    expect(isLayer(logged)).toBe(true);
    expect(isLayer({ ...logged, sent: { ...logged.sent, log: [{ id: "abc", pages: {}, words: { 1: [3] } }] } })).toBe(false);
    expect(isLayer({ ...logged, sent: { ...logged.sent, log: [{ id: "abc", pages: {}, words: ["x"] }] } })).toBe(false);
  });

  it("goes whole under the eraser and the area eraser", () => {
    const layer = withMarks(stamp(100, 100), ink([[300, 300], [400, 300]]));
    expect(marksOf(eraseAt(layer, 1, 105, 95, 2))).toHaveLength(1);
    expect(marksOf(eraseAt(layer, 1, 200, 200, 2))).toHaveLength(2);
    expect(marksOf(eraseRect(layer, 1, [85, 85], [92, 92]))).toEqual([layer.pages[1].marks[1]]);
  });

  it("has a box, a place among the marks and scales with a rebuilt page", () => {
    const s = stamp(100, 100);
    const reach = 20 * (1 + STAMP_WIDTH) / 2;
    expect(markBox(s)).toEqual([100 - reach, 100 - reach, 2 * reach, 2 * reach]);
    expect(markAnchors(withMarks(ink([[0, 200], [10, 200]]), s))).toEqual([{ page: 1, y: 90 }, { page: 1, y: 200 }]);
    // Sent at one size, then marked again on the page rebuilt at twice it:
    // the sent stamp scales with it.
    const first = markSent(withMarks(s), undefined, "r1");
    const again = markSent(addMark(first, 1, [1200, 1600], stamp(5, 5)), undefined, "r2");
    expect(again.sent!.pages[1].size).toEqual([1200, 1600]);
    expect(again.sent!.pages[1].marks[0]).toMatchObject({ kind: "stamp", at: [200, 200], size: 40 });
  });

  it("logs the words under each sent mark with its round", () => {
    const a = stamp(10, 10);
    const b = ink([[50, 50], [80, 50]]);
    const sent = markSent(withMarks(a, b), undefined, "r1", { 1: ["fox", null, "extra"] });
    expect(sent.sent!.log![0].words).toEqual({ 1: ["fox", null] });
    expect(markSent(withMarks(a, b), undefined, "r1").sent!.log![0].words).toBeUndefined();
    const some = markSentSome(withMarks(a, b), 1, [b], "r2", ["lazy"]);
    expect(some.sent!.log![0]).toMatchObject({ id: "r2", pages: { 1: [b] }, words: { 1: ["lazy"] } });
    expect(marksOf(some)).toEqual([a]);
  });
});

describe("selection and editing", () => {
  const box: Mark = { kind: "box", color: "yellow", rect: [100, 100, 50, 20] };
  const line = ink([[0, 300], [200, 300]]);
  const note: Mark = { kind: "text", color: "red", at: [400, 400], size: 12, text: "hi" };
  const layer = withMarks(box, line, stamp(120, 110), note);

  it("picks the topmost mark under a click, or none", () => {
    expect(markAt(layer.pages[1], 120, 110, 1)).toBe(2);
    expect(markAt(layer.pages[1], 102, 102, 1)).toBe(0);
    expect(markAt(layer.pages[1], 100, 300, 1)).toBe(1);
    expect(markAt(layer.pages[1], 500, 10, 1)).toBe(-1);
    expect(markAt(undefined, 0, 0, 1)).toBe(-1);
  });

  it("gathers the marks a dragged rectangle reaches, a stroke only where its ink does", () => {
    expect(marksIn(layer.pages[1], [90, 90, 200, 320])).toEqual([0, 1, 2]);
    // The stroke's middle crosses the rectangle with no sample inside it.
    expect(marksIn(layer.pages[1], [95, 290, 105, 310])).toEqual([1]);
    expect(marksIn(layer.pages[1], [450, 450, 500, 500])).toEqual([]);
    expect(marksIn(layer.pages[1], [405, 405, 395, 395])).toEqual([3]);
  });

  it("moves a selection together and keeps it on the page", () => {
    const moved = moveMarks(layer, 1, [0, 2], 10, -5);
    expect(marksOf(moved)[0]).toMatchObject({ rect: [110, 95, 50, 20] });
    expect(marksOf(moved)[2]).toMatchObject({ at: [130, 105] });
    expect(marksOf(moved)[1]).toBe(line);
    // Clamped: the box may go no further left than the page's edge.
    expect(marksOf(moveMarks(layer, 1, [0], -500, 0))[0]).toMatchObject({ rect: [0, 100, 50, 20] });
    expect(marksOf(moveMarks(layer, 1, [3], 0, 10_000))[3]).toMatchObject({ at: [400, 800 - 12 * 1.2] });
    expect(moveMarks(layer, 1, [0], 0, 0)).toBe(layer);
    expect(moveMarks(layer, 1, [9], 5, 5)).toBe(layer);
    expect(moveMarks(layer, 2, [0], 5, 5)).toBe(layer);
  });

  it("recolours only where a mark may wear the colour and restyles strokes alone", () => {
    const yellow = restyleMarks(layer, 1, [0, 1, 2, 3], { color: "yellow" });
    expect(marksOf(yellow).map((mark) => mark.color)).toEqual(["yellow", "red", "red", "red"]);
    const blue = restyleMarks(layer, 1, [0, 1, 2, 3], { color: "blue" });
    expect(marksOf(blue).map((mark) => mark.color)).toEqual(["blue", "blue", "blue", "blue"]);
    // Into the marker: wider, and yellow becomes possible.
    const marker = restyleMarks(layer, 1, [1], { style: "marker", color: "yellow" });
    expect(marksOf(marker)[1]).toMatchObject({ style: "marker", width: 10, color: "yellow" });
    // Out of the marker into the plain pen: narrower, the field gone, the yellow given up.
    const back = restyleMarks(marker, 1, [1], { style: "pen" });
    expect(marksOf(back)[1]).toEqual({ ...line, width: 2, color: "red" });
    expect("style" in marksOf(back)[1]).toBe(false);
    const pressed = withMarks({ ...line, points: [[0, 300, 0.9], [200, 300, 0.2]] });
    expect((marksOf(restyleMarks(pressed, 1, [0], { style: "dashed" }))[0] as InkMark).points).toEqual([[0, 300, 0.9], [200, 300, 0.2]]);
    expect(restyleMarks(layer, 1, [3], { style: "arrow" })).toBe(layer);
  });

  it("removes a selection", () => {
    expect(marksOf(removeMarks(layer, 1, [1, 3]))).toEqual([box, layer.pages[1].marks[2]]);
    expect(removeMarks(withMarks(box), 1, [0]).pages[1]).toBeUndefined();
    expect(removeMarks(layer, 1, [])).toBe(layer);
  });

  it("keeps a comment one plain bounded line, never on a note", () => {
    expect(cleanComment("  a\nb\u0007 c ")).toBe("a b  c");
    const commented = setComment(layer, 1, 2, "  check\tthis  ");
    expect(marksOf(commented)[2]).toMatchObject({ comment: "check this" });
    expect([...(marksOf(setComment(layer, 1, 0, "é".repeat(MAX_COMMENT + 20)))[0] as { comment: string }).comment]).toHaveLength(MAX_COMMENT);
    const cleared = setComment(commented, 1, 2, null);
    expect("comment" in marksOf(cleared)[2]).toBe(false);
    expect(marksOf(setComment(commented, 1, 2, " \n "))[2]).toEqual(marksOf(cleared)[2]);
    expect(setComment(layer, 1, 3, "no")).toBe(layer);
    expect(setComment(layer, 1, 2, "")).toBe(layer);
    expect(setComment(commented, 1, 2, "check this")).toBe(commented);
  });

  it("cuts a commented stroke keeping the comment on one piece", () => {
    const layer2 = withMarks(ink([[0, 100], [100, 100]], { comment: "why" }));
    const cut = marksOf(eraseAt(layer2, 1, 50, 100, 5));
    expect(cut).toHaveLength(2);
    expect(cut.filter((mark) => mark.kind === "ink" && mark.comment === "why")).toHaveLength(1);
  });

  it("adds several marks at once within the ceilings", () => {
    const two = [box, line];
    expect(marksOf(addMarks(EMPTY_LAYER, 3, SIZE, two), 3)).toEqual(two);
    expect(addMarks(layer, 1, SIZE, [])).toBe(layer);
    expect(canAddAll(EMPTY_LAYER, 1, two)).toBe(true);
    expect(canAddAll(EMPTY_LAYER, 1, Array.from({ length: LIMITS.marks + 1 }, () => box))).toBe(false);
    expect(canAddAll(EMPTY_LAYER, 1, [{ kind: "text", color: "red", at: [0, 0], size: 12, text: "x".repeat(LIMITS.pageText + 1) }])).toBe(false);
  });
});

describe("snapStroke", () => {
  it("straightens an almost-straight stroke and keeps its mean pressure", () => {
    const wobbly: InkMark = { kind: "ink", color: "red", width: 2, points: [[0, 0, 0.4], [50, 2, 0.6], [100, -1, 0.5], [150, 1, 0.5]] };
    expect(snapStroke(wobbly)!.points).toEqual([[0, 0, 0.5], [150, 1, 0.5]]);
  });

  it("rounds an almost-closed stroke into the ellipse it spans", () => {
    const ring: [number, number][] = [];
    for (let i = 0; i <= 20; i++) ring.push([100 + 40 * Math.cos((i / 21) * 2 * Math.PI) + (i % 2), 100 + 20 * Math.sin((i / 21) * 2 * Math.PI)]);
    const snapped = snapStroke(ink(ring))!;
    expect(snapped.points.length).toBe(49);
    for (const [x, y] of snapped.points) {
      expect(x).toBeGreaterThanOrEqual(59);
      expect(x).toBeLessThanOrEqual(142);
      expect(Math.abs(y - 100)).toBeLessThanOrEqual(21);
    }
  });

  it("makes an arrow straight however it ran, and leaves handwriting alone", () => {
    const curved = ink([[0, 0], [50, 40], [100, 0]], { style: "arrow" });
    expect(snapStroke(curved)!.points).toEqual([[0, 0, 0.5], [100, 0, 0.5]]);
    expect(snapStroke(ink([[0, 0], [20, 30], [40, 0], [60, 30], [80, 0]]))).toBeNull();
    expect(snapStroke(ink([[0, 0], [1, 1], [2, 0]]))).toBeNull();
    expect(snapStroke(ink([[5, 5]]))).toBeNull();
    expect(snapStroke(ink([[5, 5], [5, 5]], { style: "arrow" }))).toBeNull();
  });
});

/** A run of `str` at `x`, `y` (its box's top), 6 points per character, 12 high. */
const run = (str: string, x: number, y: number): TextRun => ({ str, x, y, w: 6 * str.length, h: 12 });
const RUNS: TextRun[] = [
  run("The quick brown fox jumps", 72, 100),
  run("right column", 400, 100),
  run("over the lazy dog.", 72, 120),
];

describe("textMarks and wordsIn", () => {
  it("highlights whole words across two lines, a box per line", () => {
    const marks = textMarks(RUNS, [100, 105], [140, 125], "highlight", "yellow", 2);
    expect(marks).toEqual([
      { kind: "box", color: "yellow", rect: [96, 100, 126, 12] },
      { kind: "box", color: "yellow", rect: [72, 120, 78, 12] },
    ]);
    // Dragged the other way round: the same words.
    expect(textMarks(RUNS, [140, 125], [100, 105], "highlight", "yellow", 2)).toEqual(marks);
  });

  it("strikes through and underlines with an even straight stroke", () => {
    const strike = textMarks(RUNS, [100, 105], [160, 106], "strike", "red", 1.5);
    expect(strike).toEqual([{ kind: "ink", color: "red", width: 1.5, points: [[96, 106.6, 0.5], [162, 106.6, 0.5]] }]);
    const under = textMarks(RUNS, [160, 106], [100, 105], "underline", "blue", 1.5);
    expect(under).toEqual([{ kind: "ink", color: "blue", width: 1.5, points: [[96, 110.8, 0.5], [162, 110.8, 0.5]] }]);
    // What they are on reads back as they look.
    const page: PageLayer = { size: [612, 792], marks: [...strike, ...under] };
    expect(anchorsFor(page, RUNS).map(({ how, words }) => [how, words])).toEqual([["through", "quick brown"], ["under", "quick brown"]]);
  });

  it("makes nothing where there is no text", () => {
    expect(textMarks([], [0, 0], [100, 100], "highlight", "yellow", 2)).toEqual([]);
    expect(textMarks(RUNS, [100, 400], [200, 400], "strike", "red", 2)).toEqual([]);
  });

  it("reads the words under a box", () => {
    expect(wordsIn(RUNS, [100, 100, 60, 12])).toBe("quick brown");
    expect(wordsIn(RUNS, [100, 100, 60, 32])).toBe("quick brown the lazy dog.");
    expect(wordsIn(RUNS, [300, 300, 10, 10])).toBe("");
  });

  it("anchors a caret between two words and a cross on its word", () => {
    const page: PageLayer = { size: [612, 792], marks: [stamp(129, 106, { symbol: "insert" }), stamp(177, 106)] };
    expect(anchorsFor(page, RUNS)).toEqual([
      { mark: 0, how: "at", words: "quick brown", line: "The quick brown fox jumps" },
      { mark: 1, how: "on", words: "fox", line: "The quick brown fox jumps" },
    ]);
  });
});

describe("pen prefs, round 2", () => {
  it("reads an older record with every new field at its default", () => {
    const old = parsePenPrefs({ tool: "box", colors: { ink: "blue", box: "red", text: "black" }, style: "dashed", size: 2, eraser: "area" });
    expect(old).toMatchObject({
      tool: "box",
      colors: { ink: "blue", box: "red", text: "black", stamp: "red", textmark: "yellow" },
      stamp: "insert",
      textMark: "highlight",
      snap: true,
      pressure: "normal",
      palm: "normal",
      presets: DEFAULT_PRESETS,
    });
    const odd = parsePenPrefs({ tool: "select", stamp: "swap", textMark: "strike", snap: false, pressure: "firm", palm: "nope", presets: [{ tool: "eraser", color: "red" }, { tool: "stamp", color: "blue", style: "x", size: 7 }, 3] });
    expect(odd).toMatchObject({ tool: "select", stamp: "swap", textMark: "strike", snap: false, pressure: "firm", palm: "normal" });
    expect(odd.presets).toEqual([{ tool: "stamp", color: "blue", style: "pen", size: 1 }]);
    expect(parsePenPrefs({ presets: Array.from({ length: 6 }, (_, i) => ({ tool: "ink", color: "red", style: "pen", size: i % 3 })) }).presets).toHaveLength(MAX_PRESETS);
  });

  it("offers yellow only to highlighters, the text marks' highlight among them", () => {
    expect(colorsFor("textmark", "pen", "highlight")).toContain("yellow");
    expect(colorsFor("textmark", "pen", "strike")).not.toContain("yellow");
    expect(colorsFor("stamp", "marker")).not.toContain("yellow");
    expect(colorOf({ ...DEFAULT_PEN_PREFS, tool: "textmark", textMark: "underline" })).toBe("red");
    expect(colorOf({ ...DEFAULT_PEN_PREFS, tool: "textmark" })).toBe("yellow");
    const select = { ...DEFAULT_PEN_PREFS, tool: "select" as const };
    expect(colorOf(select)).toBe("red");
    expect(withColor(select, "blue").colors.ink).toBe("blue");
  });

  it("applies, saves and resets presets", () => {
    const marker = applyPreset(DEFAULT_PEN_PREFS, DEFAULT_PRESETS[1]);
    expect(marker).toMatchObject({ tool: "ink", style: "marker", size: 1 });
    expect(colorOf(marker)).toBe("yellow");
    const boxed = applyPreset({ ...DEFAULT_PEN_PREFS, style: "arrow" }, { tool: "box", color: "blue", style: "pen", size: 2 });
    expect(boxed).toMatchObject({ tool: "box", style: "arrow", size: 2, colors: { box: "blue" } });
    const saved = savePreset({ ...DEFAULT_PEN_PREFS, tool: "stamp", colors: { ...DEFAULT_PEN_PREFS.colors, stamp: "blue" } });
    expect(saved.presets).toHaveLength(MAX_PRESETS);
    expect(saved.presets[MAX_PRESETS - 1]).toEqual({ tool: "stamp", color: "blue", style: "pen", size: 1 });
    expect(saved.presets[0]).toEqual(DEFAULT_PRESETS[1]);
    // An equal pen moves to the end instead of standing twice.
    const again = savePreset({ ...DEFAULT_PEN_PREFS, presets: DEFAULT_PRESETS });
    expect(again.presets).toEqual([DEFAULT_PRESETS[1], DEFAULT_PRESETS[2], DEFAULT_PRESETS[3], DEFAULT_PRESETS[0]]);
    const eraser = { ...DEFAULT_PEN_PREFS, tool: "eraser" as const };
    expect(savePreset(eraser)).toBe(eraser);
    expect(resetPresets(saved).presets).toEqual(DEFAULT_PRESETS);
  });

  it("bends a pen's pressure by the curve and leaves other styles even", () => {
    expect(strokePressure("pen", 0.5)).toBe(0.5);
    expect(strokePressure("pen", 0.5, "light")).toBeCloseTo(0.5 ** 0.6, 3);
    expect(strokePressure("pen", 0.5, "firm")).toBeCloseTo(0.5 ** 1.6, 3);
    expect(strokePressure("pen", 1.4, "firm")).toBe(1);
    expect(strokePressure("marker", 0.9, "light")).toBe(0.5);
  });

  it("rejects wide touches, and under strict any touch just after the pen", () => {
    const finger = { width: 12, height: 14 };
    const palm = { width: 40, height: 25 };
    expect(palmRejects("off", palm, 0)).toBe(false);
    expect(palmRejects("normal", palm, 10_000)).toBe(true);
    expect(palmRejects("normal", finger, 0)).toBe(false);
    expect(palmRejects("strict", { width: 20, height: 10 }, 10_000)).toBe(true);
    expect(palmRejects("strict", finger, 300)).toBe(true);
    expect(palmRejects("strict", finger, 900)).toBe(false);
  });
});

describe("undo steps kept with the stored layer", () => {
  const mapBackend = (): LayerBackend & { map: Map<string, unknown> } => {
    const map = new Map<string, unknown>();
    return {
      map,
      async get(key) { return structuredClone(map.get(key)); },
      async put(key, value) { map.set(key, structuredClone(value)); },
      async delete(key) { map.delete(key); },
    };
  };
  const fp = { size: 1, modified: 2 };

  it("round-trips the last steps and restores them into a history", async () => {
    let history = startHistory();
    for (let i = 0; i < 25; i++) history = commit(history, addMark(history.present, 1, SIZE, stamp(10 + i, 10)));
    const backend = mapBackend();
    expect(await saveLayer("k", history.present, fp, backend, history.past)).toBe(true);
    const stored = await loadLayer("k", backend);
    if (!stored || stored === "unavailable") throw new Error("not stored");
    expect(stored.past).toHaveLength(MAX_STORED_UNDO);
    expect(stored.past![MAX_STORED_UNDO - 1]).toEqual(history.past[history.past.length - 1]);
    const restored = undo(startHistory(stored.layer, stored.past));
    expect(marksOf(restored.present)).toHaveLength(24);
  });

  it("drops an unreadable step and loads a record from before steps", async () => {
    const backend = mapBackend();
    backend.map.set("k", { layer: withMarks(stamp(1, 1)), fingerprint: fp, saved: 1, past: [{ pages: "bad" }, withMarks()] });
    const stored = await loadLayer("k", backend);
    if (!stored || stored === "unavailable") throw new Error("not stored");
    expect(stored.past).toEqual([withMarks()]);
    backend.map.set("k", { layer: withMarks(stamp(1, 1)), fingerprint: fp, saved: 1 });
    const older = await loadLayer("k", backend);
    if (!older || older === "unavailable") throw new Error("not stored");
    expect(older.past).toBeUndefined();
    expect(await saveLayer("k", withMarks(stamp(1, 1)), fp, backend)).toBe(true);
    expect((backend.map.get("k") as { past?: unknown }).past).toBeUndefined();
  });
});

describe("drawing stamps and comment badges", () => {
  const recorder = () => {
    const calls: string[] = [];
    const ctx = {
      save: () => calls.push("save"),
      restore: () => calls.push("restore"),
      scale: () => {},
      beginPath: () => calls.push("beginPath"),
      moveTo: (x: number, y: number) => calls.push(`moveTo ${x} ${y}`),
      lineTo: (x: number, y: number) => calls.push(`lineTo ${x} ${y}`),
      quadraticCurveTo: () => calls.push("curve"),
      stroke: () => calls.push("stroke"),
      fillRect: () => calls.push("fillRect"),
      fillText: () => calls.push("fillText"),
      lineWidth: 0,
      lineCap: "butt",
      lineJoin: "miter",
      strokeStyle: "",
      fillStyle: "",
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      font: "",
      textBaseline: "alphabetic",
    } as unknown as Paint;
    return { ctx, calls };
  };

  it("strokes each of a stamp's polylines at its width", () => {
    const { ctx, calls } = recorder();
    drawMark(ctx, stamp(100, 100));
    expect(calls.filter((call) => call === "stroke")).toHaveLength(2);
    expect(calls).toContain("moveTo 92 92");
    expect(calls).toContain("lineTo 108 108");
    expect(ctx.lineWidth).toBeCloseTo(20 * STAMP_WIDTH);
    expect(calls).not.toContain("fillRect");
  });

  it("badges a commented mark, never a note", () => {
    const { ctx, calls } = recorder();
    drawMark(ctx, stamp(100, 100, { comment: "why" }));
    expect(calls.filter((call) => call === "fillRect")).toHaveLength(3);
    const note = recorder();
    drawMark(note.ctx, { kind: "text", color: "red", at: [1, 1], size: 12, text: "hi" });
    expect(note.calls).not.toContain("fillRect");
  });
});
