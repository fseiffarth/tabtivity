import { describe, it, expect } from "vitest";
import {
  appendSeries,
  applyRead,
  compileTagFilter,
  downsample,
  emptyFileState,
  extent,
  formatDuration,
  formatValue,
  groupRuns,
  groupTags,
  isEventFileName,
  isRecent,
  logTicks,
  mergeRunFiles,
  mergeSeries,
  nearestIndex,
  newestWall,
  niceTicks,
  pathData,
  runForFile,
  runStyle,
  smooth,
  tagGroup,
  tagsOf,
  unshownCounts,
  budgetOf,
  emptyViewBudget,
  SERIES_CAP,
  VIEW_MAX_POINTS,
  VIEW_MAX_SERIES_NAMES,
  VIEW_MAX_TAGS,
  type TfPoint,
  type TfReadResult,
} from "../../lib/viewers/tensorboard";

const pt = (step: number, value: number, wall = step): TfPoint => [step, wall, value];
const ramp = (n: number, from = 0): TfPoint[] => Array.from({ length: n }, (_, i) => pt(from + i, (i % 17) + 1));

function read(over: Partial<TfReadResult> = {}): TfReadResult {
  return {
    cursor: { offset: 10, size: 10, mtime: 1 },
    reset: false,
    scalars: {},
    skipped: { series: {}, nonFinite: 0, oversized: 0, malformed: 0, dropped: 0, badCrc: false },
    truncated: false,
    fileVersion: null,
    ...over,
  };
}

describe("event file names", () => {
  it("matches the prefix only", () => {
    expect(isEventFileName("events.out.tfevents.1700000000.host.12.0")).toBe(true);
    expect(isEventFileName("events.out.tfevents.1.v2")).toBe(true);
    expect(isEventFileName("events.out.tfevents")).toBe(false);
    expect(isEventFileName("old.events.out.tfevents.1")).toBe(false);
  });
});

describe("groupRuns", () => {
  const root = "/p/logs";
  it("makes every folder holding event files a run, named relative to the root", () => {
    const runs = groupRuns(root, [
      "/p/logs/b/events.out.tfevents.2.h",
      "/p/logs/a/val/events.out.tfevents.1.h",
      "/p/logs/a/events.out.tfevents.3.h",
    ]);
    expect(runs.map((r) => r.name)).toEqual(["a", "a/val", "b"]);
  });

  it("names the root's own run after the root folder", () => {
    const runs = groupRuns(root, ["/p/logs/events.out.tfevents.1.h"]);
    expect(runs.map((r) => r.name)).toEqual(["logs"]);
  });

  it("orders a run's files oldest first and keeps restarts together", () => {
    const [run] = groupRuns(root, [
      "/p/logs/r/events.out.tfevents.1700000900.h.1.0",
      "/p/logs/r/events.out.tfevents.1700000100.h.1.0",
    ]);
    expect(run.files.map((f) => f.split("/").pop())).toEqual([
      "events.out.tfevents.1700000100.h.1.0",
      "events.out.tfevents.1700000900.h.1.0",
    ]);
  });

  it("copes with Windows separators", () => {
    const runs = groupRuns("C:\\p\\logs", ["C:\\p\\logs\\a\\events.out.tfevents.1.h"]);
    expect(runs.map((r) => r.name)).toEqual(["a"]);
  });

  it("names a single opened file's run after its folder", () => {
    expect(runForFile("/p/logs/run1/events.out.tfevents.1.h").name).toBe("run1");
  });
});

describe("mergeSeries", () => {
  it("appends a live tail without re-sorting", () => {
    const a = [pt(0, 1), pt(1, 2)];
    expect(mergeSeries(a, [pt(2, 3)])).toEqual([pt(0, 1), pt(1, 2), pt(2, 3)]);
    expect(mergeSeries([], [pt(2, 3)])).toEqual([pt(2, 3)]);
    expect(mergeSeries(a, [])).toEqual(a);
  });

  it("lets the later write win on a step both hold, in step order", () => {
    const merged = mergeSeries([pt(0, 1), pt(1, 2), pt(2, 3)], [pt(1, 20), pt(5, 50)]);
    expect(merged).toEqual([pt(0, 1), pt(1, 20), pt(2, 3), pt(5, 50)]);
  });

  it("does not mutate its inputs", () => {
    const a = [pt(0, 1)];
    mergeSeries(a, [pt(1, 2)]);
    expect(a).toEqual([pt(0, 1)]);
  });
});

describe("downsample", () => {
  it("leaves a short series alone", () => {
    const p = ramp(10);
    expect(downsample(p, 10)).toEqual(p);
  });

  it("is bounded, keeps the ends and the extremes, in step order", () => {
    const p = ramp(50_000);
    p[12_345] = pt(12_345, 9999);
    p[40_000] = pt(40_000, -9999);
    const d = downsample(p, 1500);
    expect(d.length).toBeLessThanOrEqual(1500);
    expect(d[0]).toEqual(p[0]);
    expect(d[d.length - 1]).toEqual(p[p.length - 1]);
    expect(d.some((x) => x[2] === 9999)).toBe(true);
    expect(d.some((x) => x[2] === -9999)).toBe(true);
    for (let i = 1; i < d.length; i++) expect(d[i][0]).toBeGreaterThan(d[i - 1][0]);
  });

  it("appendSeries thins a series that outgrows its cap", () => {
    let s: TfPoint[] = [];
    for (let i = 0; i < 8; i++) s = appendSeries(s, ramp(1000, i * 1000));
    expect(s.length).toBeLessThanOrEqual(SERIES_CAP);
    expect(s[s.length - 1][0]).toBe(7999);
  });
});

describe("applyRead", () => {
  it("accumulates new points per tag and counts what is not drawn", () => {
    let st = emptyFileState();
    st = applyRead(st, read({ scalars: { loss: [pt(0, 2), pt(1, 1)] }, skipped: { ...read().skipped, series: { image: ["a"] }, nonFinite: 2 } }));
    st = applyRead(st, read({ scalars: { loss: [pt(2, 0.5)], acc: [pt(2, 0.9)] }, skipped: { ...read().skipped, series: { image: ["a", "b"] }, nonFinite: 1 } }));
    expect(st.scalars.get("loss")?.map((p) => p[0])).toEqual([0, 1, 2]);
    expect([...st.scalars.keys()].sort()).toEqual(["acc", "loss"]);
    expect(st.series.get("image")).toEqual(["a", "b"]);
    expect(st.nonFinite).toBe(3);
  });

  it("drops what it kept when the file was replaced (reset)", () => {
    let st = applyRead(emptyFileState(), read({ scalars: { loss: [pt(0, 1), pt(1, 1)] } }));
    st = applyRead(st, read({ reset: true, scalars: { other: [pt(0, 5)] } }));
    expect([...st.scalars.keys()]).toEqual(["other"]);
  });

  it("keeps the cursor of the latest read", () => {
    const st = applyRead(emptyFileState(), read({ cursor: { offset: 7, size: 9, mtime: 3 } }));
    expect(st.cursor).toEqual({ offset: 7, size: 9, mtime: 3 });
  });
});

/** A read answer as the backend's JSON arrives: parsed, so `__proto__` is an
 *  own key (an object literal would set the prototype instead). */
function wire(scalars: Record<string, TfPoint[]> | [string, TfPoint[]][], series: [string, string[]][] = []): TfReadResult {
  const pairs = Array.isArray(scalars) ? scalars : Object.entries(scalars);
  const json = `{${pairs.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",")}}`;
  const kinds = `{${series.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",")}}`;
  return read({ scalars: JSON.parse(json), skipped: { ...read().skipped, series: JSON.parse(kinds) } });
}

const SPECIAL = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "prototype"];

describe("names from the file are data", () => {
  it("round-trips special property names as tags and kinds, on the first and later reads", () => {
    const protoBefore = Object.getOwnPropertyNames(Object.prototype).sort();
    const budget = emptyViewBudget();
    let st = emptyFileState();
    const first = wire(SPECIAL.map((t, i) => [t, [pt(0, i + 1)]]), SPECIAL.map((k) => [k, ["__proto__", "x"]]));
    expect(Object.keys(first.scalars)).toContain("__proto__");
    st = applyRead(st, first, budget);
    st = applyRead(st, wire(SPECIAL.map((t, i) => [t, [pt(1, i + 10)]]), SPECIAL.map((k) => [k, ["y"]])), budget);
    for (const [i, tag] of SPECIAL.entries()) {
      expect(st.scalars.get(tag)).toEqual([pt(0, i + 1), pt(1, i + 10)]);
      expect(mergeRunFiles([st], tag)).toEqual([pt(0, i + 1), pt(1, i + 10)]);
    }
    expect(tagsOf([st])).toEqual([...SPECIAL].sort());
    expect(unshownCounts([st])).toEqual([...SPECIAL].sort().map((kind) => ({ kind, count: 3 })));
    expect(newestWall([st])).toBe(1);
    expect(mergeRunFiles([st], "missing")).toEqual([]);
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(protoBefore);
    expect(({} as Record<string, unknown>).loss).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("leaves the ordinary series result as it was", () => {
    const st = applyRead(emptyFileState(), wire({ loss: [pt(0, 2), pt(1, 1)] }, [["image", ["b", "a"]]]));
    expect(st.scalars.get("loss")).toEqual([pt(0, 2), pt(1, 1)]);
    expect(st.series.get("image")).toEqual(["a", "b"]);
    expect(st.overBudgetPoints).toBe(0);
    expect(st.overBudgetSeries).toBe(0);
  });
});

describe("the view's budget", () => {
  const batch = (from: number, n: number): TfReadResult =>
    wire(Array.from({ length: n }, (_, i): [string, TfPoint[]] => [`t${from + i}`, [pt(0, 1)]]));

  it("keeps three disjoint batches of 2,000 tags within one view's limit and counts the rest", () => {
    const budget = emptyViewBudget();
    let st = emptyFileState();
    for (let b = 0; b < 3; b++) st = applyRead(st, batch(b * 2000, 2000), budget);
    expect(st.scalars.size).toBe(VIEW_MAX_TAGS);
    expect(budget.tags.size).toBe(VIEW_MAX_TAGS);
    expect(st.overBudgetPoints).toBe(4000);
    // Tags it already holds keep following.
    st = applyRead(st, wire({ t0: [pt(1, 2)] }), budget);
    expect(st.scalars.get("t0")).toHaveLength(2);
  });

  it("is shared by every file of the view, and a tag in two files counts once", () => {
    const budget = emptyViewBudget();
    const files = Array.from({ length: 6 }, (_, f) => applyRead(emptyFileState(), batch(f * 500, 1000), budget));
    expect(tagsOf(files)).toHaveLength(VIEW_MAX_TAGS);
    // Files 0–2 keep all 1,000 each (the third reaches 2,000 tags), file 3
    // only the 500 tags already held, files 4 and 5 none.
    expect(files.map((s) => s.scalars.size)).toEqual([1000, 1000, 1000, 500, 0, 0]);
    expect(files.reduce((n, s) => n + s.overBudgetPoints, 0)).toBe(2500);
    expect(budgetOf(files).tags.size).toBe(budget.tags.size);
    expect(budgetOf(files).points).toBe(budget.points);
  });

  it("bounds other-kind series names across files", () => {
    const budget = emptyViewBudget();
    const names = (from: number) => Array.from({ length: 1500 }, (_, i) => `n${from + i}`);
    const a = applyRead(emptyFileState(), wire({}, [["image", names(0)]]), budget);
    const b = applyRead(emptyFileState(), wire({}, [["histogram", names(0)], ["image", names(0)]]), budget);
    expect(unshownCounts([a, b]).reduce((n, u) => n + u.count, 0)).toBe(VIEW_MAX_SERIES_NAMES);
    expect(a.overBudgetSeries + b.overBudgetSeries).toBe(1000);
  });

  it("bounds the points of all series together, still moving a full series to its newest point", () => {
    const budget = emptyViewBudget();
    budget.points = VIEW_MAX_POINTS - 10;
    let st = applyRead(emptyFileState(), wire({ a: ramp(8) }), budget);
    expect(st.scalars.get("a")).toHaveLength(8);
    st = applyRead(st, wire({ a: ramp(5, 8), b: ramp(3) }), budget);
    expect(budget.points).toBeLessThanOrEqual(VIEW_MAX_POINTS);
    const a = st.scalars.get("a")!;
    expect(a.length).toBe(10);
    expect(a[a.length - 1][0]).toBe(12);
    expect(st.scalars.has("b")).toBe(false);
    expect(st.overBudgetPoints).toBe(3 + 3);
  });

  it("gives a file's share back on a reset, and survives a fold into the same file again", () => {
    const budget = emptyViewBudget();
    let st = applyRead(emptyFileState(), batch(0, 2000), budget);
    const other = applyRead(emptyFileState(), batch(2000, 10), budget);
    expect(other.scalars.size).toBe(0);
    st = applyRead(st, { ...batch(5000, 3), reset: true }, budget);
    expect([...st.scalars.keys()]).toEqual(["t5000", "t5001", "t5002"]);
    expect(st.overBudgetPoints).toBe(0);
    expect(budget.tags.size).toBe(3);
    expect(budget.points).toBe(3);
    const again = applyRead(other, batch(2000, 10), budget);
    expect(again.scalars.size).toBe(10);
  });
});

describe("runs from several files", () => {
  it("merges a restart into the run by step, the later file winning", () => {
    const a = applyRead(emptyFileState(), read({ scalars: { loss: [pt(0, 5), pt(1, 4), pt(2, 3)] } }));
    const b = applyRead(emptyFileState(), read({ scalars: { loss: [pt(2, 30), pt(3, 20)] } }));
    expect(mergeRunFiles([a, b], "loss")).toEqual([pt(0, 5), pt(1, 4), pt(2, 30), pt(3, 20)]);
    expect(mergeRunFiles([a, b], "missing")).toEqual([]);
  });

  it("lists tags, the newest wall time, liveness and unshown series", () => {
    const a = applyRead(emptyFileState(), read({ scalars: { "train/loss": [pt(0, 1, 100)] }, skipped: { ...read().skipped, series: { image: ["i1", "i2"], histogram: ["h"] } } }));
    const b = applyRead(emptyFileState(), read({ scalars: { acc: [pt(0, 1, 250)] }, skipped: { ...read().skipped, series: { image: ["i2", "i3"] } } }));
    expect(tagsOf([a, b])).toEqual(["acc", "train/loss"]);
    expect(newestWall([a, b])).toBe(250);
    expect(unshownCounts([a, b])).toEqual([
      { kind: "histogram", count: 1 },
      { kind: "image", count: 3 },
    ]);
    expect(isRecent(1000, 1000 * 1000 + 5 * 60_000)).toBe(true);
    expect(isRecent(1000, 1000 * 1000 + 11 * 60_000)).toBe(false);
    expect(isRecent(0, 5)).toBe(false);
  });
});

describe("tags", () => {
  it("groups by the prefix before the first slash", () => {
    expect(tagGroup("train/loss")).toBe("train");
    expect(tagGroup("a/b/c")).toBe("a");
    expect(tagGroup("loss")).toBe("");
    expect(tagGroup("/odd")).toBe("");
    const g = groupTags(["loss", "val/acc", "train/loss", "train/acc", "lr"]);
    expect(g.map((x) => x.group)).toEqual(["train", "val", ""]);
    expect(g[0].tags).toEqual(["train/acc", "train/loss"]);
    expect(g[2].tags).toEqual(["loss", "lr"]);
  });

  it("filters by substring, or by regex after a leading slash", () => {
    const tags = ["train/loss", "val/loss", "train/acc", "Lr"];
    const run = (q: string) => tags.filter(compileTagFilter(q).test);
    expect(run("")).toEqual(tags);
    expect(run("LOSS")).toEqual(["train/loss", "val/loss"]);
    expect(run("/^train")).toEqual(["train/loss", "train/acc"]);
    expect(run("/loss$/")).toEqual(["train/loss", "val/loss"]);
    expect(run("/")).toEqual(tags);
  });

  it("says so, and matches nothing, for an invalid regex", () => {
    const f = compileTagFilter("/(");
    expect(f.invalid).toBe(true);
    expect(f.test("anything")).toBe(false);
  });
});

describe("smooth", () => {
  it("is the raw line at weight 0", () => {
    const p = [pt(0, 1), pt(1, 5), pt(2, 3)];
    expect(smooth(p, 0)).toEqual([1, 5, 3]);
  });

  it("is TensorBoard's debiased EMA: the first value is exact, a constant stays constant", () => {
    const p = [pt(0, 4), pt(1, 4), pt(2, 4), pt(3, 4)];
    for (const v of smooth(p, 0.6)) expect(v).toBeCloseTo(4, 10);
    expect(smooth([pt(0, 7)], 0.9)[0]).toBeCloseTo(7, 10);
  });

  it("matches a hand-worked value", () => {
    // w = 0.5: last1 = 0.5*1 = 0.5, /0.5 = 1; last2 = 0.25 + 0.5*3 = 1.75, /0.75.
    const [a, b] = smooth([pt(0, 1), pt(1, 3)], 0.5);
    expect(a).toBeCloseTo(1, 10);
    expect(b).toBeCloseTo(1.75 / 0.75, 10);
  });

  it("clamps a weight at or above 1 instead of dividing by zero", () => {
    for (const v of smooth([pt(0, 1), pt(1, 2)], 5)) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("chart maths", () => {
  it("picks nice ticks", () => {
    expect(niceTicks(0, 100, 4)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(0, 100, 2)).toEqual([0, 50, 100]);
    expect(niceTicks(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(3, 3, 4)).toEqual([3]);
    expect(niceTicks(NaN, 1, 4)).toEqual([]);
    // A span of a few ulps is one value, not fifty copies of it.
    expect(niceTicks(0.1 - 1e-17, 0.1, 4)).toHaveLength(1);
    const t = niceTicks(0.09, 0.11, 4);
    expect(new Set(t).size).toBe(t.length);
  });

  it("gives decades on a log axis", () => {
    expect(logTicks(0.02, 5)).toEqual([0.01, 0.1, 1, 10]);
    expect(logTicks(0, 5)).toEqual([]);
  });

  it("formats values and durations", () => {
    expect(formatValue(0)).toBe("0");
    expect(formatValue(0.123456)).toBe("0.123");
    expect(formatValue(12.3456)).toBe("12.346");
    expect(formatValue(123456)).toBe("123456");
    expect(formatValue(1.5e-5)).toBe("1.50e-5");
    expect(formatValue(NaN)).toBe("");
    expect(formatDuration(5)).toBe("5s");
    expect(formatDuration(185)).toBe("3m 05s");
    expect(formatDuration(3720)).toBe("1h 02m");
  });

  it("finds the nearest point by binary search", () => {
    const xs = [0, 10, 20, 40];
    expect(nearestIndex(xs, -5)).toBe(0);
    expect(nearestIndex(xs, 4)).toBe(0);
    expect(nearestIndex(xs, 6)).toBe(1);
    expect(nearestIndex(xs, 29)).toBe(2);
    expect(nearestIndex(xs, 31)).toBe(3);
    expect(nearestIndex(xs, 1000)).toBe(3);
    expect(nearestIndex([], 1)).toBe(-1);
  });

  it("takes the extent over lines, ignoring non-positive y on a log axis", () => {
    const lines = [
      { xs: [0, 1, 2], ys: [3, 0, 5] },
      { xs: [1, 4], ys: [-1, 2] },
    ];
    expect(extent(lines, false)).toEqual({ x0: 0, x1: 4, y0: -1, y1: 5 });
    expect(extent(lines, true)).toEqual({ x0: 0, x1: 4, y0: 2, y1: 5 });
    expect(extent([], false)).toBeNull();
    expect(extent([{ xs: [0], ys: [NaN] }], false)).toBeNull();
  });

  it("breaks the path at gaps instead of drawing through them", () => {
    const d = pathData({ xs: [0, 1, 2, 3], ys: [1, 0, 2, 3] }, (x) => x, (y) => y, true);
    expect(d).toBe("M0.0 1.0M2.0 2.0L3.0 3.0");
  });
});

describe("run colours", () => {
  it("keeps eight distinct slots, then repeats them dashed rather than inventing hues", () => {
    expect(runStyle(0)).toEqual({ slot: 1, dash: null });
    expect(runStyle(7)).toEqual({ slot: 8, dash: null });
    expect(runStyle(8).slot).toBe(1);
    expect(runStyle(8).dash).not.toBeNull();
    expect(runStyle(16).dash).not.toBe(runStyle(8).dash);
  });
});
