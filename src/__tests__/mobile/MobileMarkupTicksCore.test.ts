/**
 * Markup ticks, the pure half (`docs/markup_tick_approve_plan.md` §3): a
 * Submit with a round id logs its marks as sent; the agent's ticks (round id,
 * page, 1-based mark) map back onto the sent side — by reference, else by
 * equality for a record rebuilt from a copy — and only the reader's approval
 * removes a mark. The log rides in the stored record and older records
 * without it stay readable.
 */
import { describe, expect, it } from "vitest";

import {
  addMark, approveMark, approveMarks, clearAll, clearSent, EMPTY_LAYER, eraseAt, forgetRound, isLayer, LIMITS, markBox, markSent,
  MAX_LOGGED_ROUNDS, mintRound, tickedMarks,
  type BoxMark, type InkMark, type Layer, type TextMark,
} from "../../../mobile-web/src/markup/layer";
import { loadLayer, saveLayer, type LayerBackend } from "../../../mobile-web/src/markup/store";

const SIZE: [number, number] = [612, 792];
const ink = (x: number): InkMark => ({ kind: "ink", color: "red", width: 2, points: [[x, 10, 0.5], [x + 20, 30, 0.5]] });
const box = (x: number): BoxMark => ({ kind: "box", color: "yellow", rect: [x, 50, 40, 10] });
const note = (text: string): TextMark => ({ kind: "text", color: "black", at: [100, 100], size: 20, text });

/** Page 1: ink(10), box(20); page 2: note — sent as round `r1`. */
function sentOnce(): Layer {
  let layer = addMark(EMPTY_LAYER, 1, SIZE, ink(10));
  layer = addMark(layer, 1, SIZE, box(20));
  layer = addMark(layer, 2, SIZE, note("fix"));
  return markSent(layer, undefined, "r1");
}

describe("markup ticks · round log", () => {
  it("logs a Submit's marks as sent, the same objects in the same order", () => {
    const before = addMark(addMark(EMPTY_LAYER, 1, SIZE, ink(10)), 1, SIZE, box(20));
    const after = markSent(before, [1], "r1");
    expect(after.sent?.log).toEqual([{ id: "r1", pages: { 1: before.pages[1].marks } }]);
    expect(after.sent!.log![0].pages[1]).toBe(before.pages[1].marks);
    expect(after.sent!.log![0].pages[1][1]).toBe(after.sent!.pages[1].marks[1]);
  });

  it("logs nothing without a round id, and keeps an earlier log", () => {
    const plain = markSent(addMark(EMPTY_LAYER, 1, SIZE, ink(10)));
    expect(plain.sent).not.toHaveProperty("log");
    const first = sentOnce();
    const second = markSent(addMark(first, 3, SIZE, ink(5)));
    expect(second.sent?.log).toBe(first.sent?.log);
  });

  it("keeps only the newest rounds", () => {
    let layer: Layer = EMPTY_LAYER;
    for (let i = 0; i < MAX_LOGGED_ROUNDS + 2; i++) layer = markSent(addMark(layer, 1, SIZE, ink(i)), undefined, `r${i}`);
    expect(layer.sent?.log?.map((entry) => entry.id)).toEqual(Array.from({ length: MAX_LOGGED_ROUNDS }, (_, i) => `r${i + 2}`));
  });

  it("drops the oldest rounds while the log passes the sent side's bound", () => {
    const heavy = (n: number): InkMark => ({ ...ink(n), points: Array.from({ length: LIMITS.points - 1 }, (_, i): [number, number, number] => [i % 600, n, 0.5]) });
    let layer: Layer = EMPTY_LAYER;
    for (let i = 0; i < 5; i++) layer = markSent(addMark(layer, 1, SIZE, heavy(i)), undefined, `r${i}`);
    // Four rounds of nearly LIMITS.points each fill SENT_LIMITS.points.
    expect(layer.sent?.log?.map((entry) => entry.id)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(layer.sent?.pages[1].marks).toHaveLength(5);
  });

  it("mints round ids the backend takes", () => {
    const ids = new Set(Array.from({ length: 50 }, mintRound));
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{8}$/);
    expect(ids.size).toBe(50);
  });
});

describe("markup ticks · mapping", () => {
  it("maps a tick to its sent mark by reference", () => {
    const layer = sentOnce();
    expect(tickedMarks(layer, [{ round: "r1", page: 1, mark: 2 }, { round: "r1", page: 2, mark: 1 }])).toEqual([
      { page: 1, index: 1, round: "r1" },
      { page: 2, index: 0, round: "r1" },
    ]);
  });

  it("finds marks behind a later round's on the same page", () => {
    const first = sentOnce();
    const second = markSent(addMark(first, 1, SIZE, ink(300)), undefined, "r2");
    expect(tickedMarks(second, [{ round: "r2", page: 1, mark: 1 }, { round: "r1", page: 1, mark: 1 }])).toEqual([
      { page: 1, index: 0, round: "r1" },
      { page: 1, index: 2, round: "r2" },
    ]);
  });

  it("drops ticks of unknown rounds, past the round's marks, of erased marks; never an unsent mark; once each", () => {
    let layer = sentOnce();
    layer = addMark(layer, 1, SIZE, ink(10));
    expect(tickedMarks(layer, [
      { round: "zz", page: 1, mark: 1 },
      { round: "r1", page: 1, mark: 3 },
      { round: "r1", page: 3, mark: 1 },
      { round: "r1", page: 1, mark: 1 },
      { round: "r1", page: 1, mark: 1 },
    ])).toEqual([{ page: 1, index: 0, round: "r1" }]);
    // The box erased whole: its tick finds nothing.
    const erased = eraseAt(layer, 1, 40, 55, 2, true);
    expect(erased.sent?.pages[1].marks).toHaveLength(1);
    expect(tickedMarks(erased, [{ round: "r1", page: 1, mark: 2 }])).toEqual([]);
  });

  it("falls back to equal marks when the record is a copy", () => {
    const copy = JSON.parse(JSON.stringify(sentOnce())) as Layer;
    expect(tickedMarks(copy, [{ round: "r1", page: 1, mark: 2 }])).toEqual([{ page: 1, index: 1, round: "r1" }]);
  });

  it("does not hand an approved mark's badge to its twin", () => {
    let layer = addMark(addMark(EMPTY_LAYER, 1, SIZE, box(20)), 1, SIZE, box(20));
    layer = markSent(layer, undefined, "r1");
    const both = tickedMarks(layer, [{ round: "r1", page: 1, mark: 1 }, { round: "r1", page: 1, mark: 2 }]);
    expect(both.map((entry) => entry.index)).toEqual([0, 1]);
    const approved = approveMark(layer, 1, 0);
    expect(tickedMarks(approved, [{ round: "r1", page: 1, mark: 1 }])).toEqual([]);
    expect(tickedMarks(approved, [{ round: "r1", page: 1, mark: 2 }])).toEqual([{ page: 1, index: 0, round: "r1" }]);
    // In a copy, equal twins are each claimed once.
    const copy = JSON.parse(JSON.stringify(layer)) as Layer;
    expect(tickedMarks(copy, [{ round: "r1", page: 1, mark: 1 }, { round: "r1", page: 1, mark: 2 }]).map((entry) => entry.index)).toEqual([0, 1]);
  });

  it("does not hand an approved mark's badge to another round's twin", () => {
    // Round r1's only mark on page 1 and round r2's are equal boxes.
    const first = markSent(addMark(EMPTY_LAYER, 1, SIZE, box(20)), undefined, "r1");
    const second = markSent(addMark(first, 1, SIZE, box(20)), undefined, "r2");
    const approved = approveMark(second, 1, 0);
    expect(approved.sent?.pages[1].marks).toHaveLength(1);
    // r1's mark is gone; r2's own twin is not r1's to badge.
    expect(tickedMarks(approved, [{ round: "r1", page: 1, mark: 1 }])).toEqual([]);
    expect(tickedMarks(approved, [{ round: "r2", page: 1, mark: 1 }])).toEqual([{ page: 1, index: 0, round: "r2" }]);
  });

  it("still maps after a later round rescaled the page", () => {
    const first = markSent(addMark(EMPTY_LAYER, 1, [600, 800], box(100)), undefined, "r1");
    const second = markSent(addMark(first, 1, [300, 400], ink(5)), undefined, "r2");
    expect(second.sent?.pages[1].marks[0]).toEqual({ ...box(100), rect: [50, 25, 20, 5] });
    expect(second.sent!.log![0].pages[1][0]).toBe(second.sent!.pages[1].marks[0]);
    expect(tickedMarks(second, [{ round: "r1", page: 1, mark: 1 }])).toEqual([{ page: 1, index: 0, round: "r1" }]);
  });
});

describe("markup ticks · approve and forget", () => {
  it("approving removes only that sent mark; the page goes with its last", () => {
    const layer = addMark(sentOnce(), 1, SIZE, ink(400));
    const one = approveMark(layer, 1, 0);
    expect(one.sent?.pages[1].marks).toEqual([box(20)]);
    expect(one.pages).toBe(layer.pages);
    expect(one.sent?.log).toBe(layer.sent?.log);
    expect(approveMark(layer, 1, 9)).toBe(layer);
    const all = approveMarks(layer, tickedMarks(layer, [{ round: "r1", page: 1, mark: 1 }, { round: "r1", page: 1, mark: 2 }, { round: "r1", page: 2, mark: 1 }]));
    expect(all.sent?.pages).toEqual({});
    expect(all.pages[1].marks).toEqual([ink(400)]);
  });

  it("Clear sent marks and Clear all marks drop the log; forgetting a round drops it alone", () => {
    const layer = markSent(addMark(sentOnce(), 1, SIZE, ink(400)), undefined, "r2");
    expect(clearSent(layer).sent).toBeUndefined();
    expect(clearAll(layer, true).sent).toEqual({ pages: {}, rounds: 2 });
    const forgot = forgetRound(layer, "r1");
    expect(forgot.sent?.log?.map((entry) => entry.id)).toEqual(["r2"]);
    expect(forgot.sent?.pages).toBe(layer.sent?.pages);
    expect(tickedMarks(forgot, [{ round: "r1", page: 1, mark: 1 }])).toEqual([]);
    expect(forgetRound(forgot, "r1")).toBe(forgot);
    expect(forgetRound(forgot, "r2").sent).not.toHaveProperty("log");
  });

  it("boxes each kind of mark", () => {
    expect(markBox({ kind: "box", color: "red", rect: [50, 60, -20, -10] })).toEqual([30, 50, 20, 10]);
    expect(markBox(note("ab"))).toEqual([100, 100, 2 * 20 * 0.72, 20 * 1.2]);
    const [x, y, w, h] = markBox(ink(10));
    expect([x, y, w, h].map((v) => Math.round(v * 100) / 100)).toEqual([8.3, 8.3, 23.4, 23.4]);
  });
});

describe("markup ticks · stored records", () => {
  const memory = (): LayerBackend & { map: Map<string, unknown> } => {
    const map = new Map<string, unknown>();
    return { map, get: async (k) => structuredClone(map.get(k)), put: async (k, v) => { map.set(k, structuredClone(v)); }, delete: async (k) => { map.delete(k); } };
  };

  it("validates the log when there is one, and records without it stay valid", () => {
    const layer = sentOnce();
    expect(isLayer(layer)).toBe(true);
    expect(isLayer(clearSent(layer))).toBe(true);
    expect(isLayer({ pages: {}, sent: { pages: {}, rounds: 1 } })).toBe(true);
    expect(isLayer({ ...layer, sent: { ...layer.sent, log: "x" } })).toBe(false);
    expect(isLayer({ ...layer, sent: { ...layer.sent, log: [{ id: "BAD!", pages: {} }] } })).toBe(false);
    expect(isLayer({ ...layer, sent: { ...layer.sent, log: [{ id: "r1", pages: { 0: [] } }] } })).toBe(false);
    expect(isLayer({ ...layer, sent: { ...layer.sent, log: [{ id: "r1", pages: { 1: [{ kind: "nope" }] } }] } })).toBe(false);
  });

  it("round-trips the log with its marks still the sent side's, and drops only a bad log", async () => {
    const backend = memory();
    const layer = sentOnce();
    expect(await saveLayer("k", layer, { size: 1, modified: 1 }, backend)).toBe(true);
    const stored = await loadLayer("k", backend);
    if (!stored || stored === "unavailable") throw new Error("not stored");
    expect(stored.layer).toEqual(layer);
    expect(stored.layer.sent!.log![0].pages[1][0]).toBe(stored.layer.sent!.pages[1].marks[0]);
    expect(tickedMarks(stored.layer, [{ round: "r1", page: 2, mark: 1 }])).toEqual([{ page: 2, index: 0, round: "r1" }]);
    backend.map.set("k", { layer: { ...layer, sent: { ...layer.sent, log: [{ id: 7 }] } }, fingerprint: { size: 1, modified: 1 }, saved: 1 });
    const kept = await loadLayer("k", backend);
    if (!kept || kept === "unavailable") throw new Error("not read");
    expect(kept.layer.sent).toEqual({ pages: layer.sent!.pages, rounds: 1 });
  });
});
