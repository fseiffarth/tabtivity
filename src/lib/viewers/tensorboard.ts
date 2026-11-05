/**
 * Pure logic of the native TensorBoard viewer (`docs/tensorboard_viewer_plan.md`):
 * run grouping, merging what `tfevents_read` returns across refreshes, tag
 * groups and filters, TensorBoard's debiased smoothing, and the chart maths.
 * Nothing here touches React or `invoke`, so it is all unit-tested.
 */

import { basename, dirname, relativePathWithin } from "../paths";

/** `[step, wallSeconds, value]`, the wire shape of one scalar sample. */
export type TfPoint = readonly [number, number, number];

/** Where the previous `tfevents_read` stopped; handed back verbatim. */
export interface TfCursor {
  offset: number;
  size: number;
  mtime: number;
}

/** What a read met and did not draw (`services::tfevents::Skipped`). */
export interface TfSkipped {
  /** Other kinds of series (`image`, `histogram`, …) → their tag names. */
  series: Record<string, string[]>;
  nonFinite: number;
  oversized: number;
  malformed: number;
  dropped: number;
  badCrc: boolean;
}

/** The answer of `tfevents_read`. */
export interface TfReadResult {
  cursor: TfCursor;
  reset: boolean;
  scalars: Record<string, TfPoint[]>;
  skipped: TfSkipped;
  truncated: boolean;
  fileVersion: string | null;
}

/** One file found by `tfevents_discover`. */
export interface TfFileInfo {
  path: string;
  size: number;
  mtime: number;
}

/** TensorBoard's event files: `events.out.tfevents.<time>.<host>.<pid>.<n>`. */
export const EVENT_FILE_PREFIX = "events.out.tfevents.";

/** Whether a bare file name is a TensorBoard event file. */
export function isEventFileName(name: string): boolean {
  return name.startsWith(EVENT_FILE_PREFIX);
}

// ── Runs ─────────────────────────────────────────────────────────────────

/** A run: the event files of one folder, oldest first. */
export interface TfRun {
  /** The label: the folder's path below the one opened (`.` as its own name). */
  name: string;
  files: string[];
}

/**
 * Group discovered event files into runs: every folder holding event files is a
 * run, named by its path relative to `root`. Event files straight in `root`
 * form a run named after `root` itself. Files within a run sort by name, which
 * carries the start time, so a later file (a restart) comes after an earlier one.
 */
export function groupRuns(root: string, files: readonly string[]): TfRun[] {
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    const dir = dirname(f);
    const list = byDir.get(dir);
    if (list) list.push(f);
    else byDir.set(dir, [f]);
  }
  const runs: TfRun[] = [];
  for (const [dir, list] of byDir) {
    const rel = relativePathWithin(root, dir);
    const name = rel ? rel : basename(root) || root;
    runs.push({ name, files: [...list].sort(byBaseName) });
  }
  return runs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function byBaseName(a: string, b: string): number {
  const x = basename(a);
  const y = basename(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The single run an opened event file stands for: named after its folder. */
export function runForFile(path: string): TfRun {
  return { name: basename(dirname(path)) || basename(path), files: [path] };
}

// ── Merging reads ────────────────────────────────────────────────────────

/** Most points a series keeps before it is thinned (the view needs far fewer). */
export const SERIES_CAP = 6000;
/** What a series is thinned to when it passes [`SERIES_CAP`]. */
export const SERIES_KEEP = 3000;

/**
 * Add `incoming` to a step-ordered series. A point at a step already present
 * replaces it (a restarted run rewrites the same steps); anything else is
 * merged in step order. The common case, a live append, is a concatenation.
 */
export function mergeSeries(existing: readonly TfPoint[], incoming: readonly TfPoint[]): TfPoint[] {
  if (incoming.length === 0) return existing.slice();
  if (existing.length === 0 || incoming[0][0] > existing[existing.length - 1][0]) {
    return [...existing, ...incoming];
  }
  const byStep = new Map<number, TfPoint>();
  for (const p of existing) byStep.set(p[0], p);
  for (const p of incoming) byStep.set(p[0], p);
  return [...byStep.values()].sort((a, b) => a[0] - b[0]);
}

/**
 * Thin a series to at most `max` points, keeping the first and last and, per
 * bucket in between, its lowest and highest value in step order: a spike
 * survives where a plain stride would drop it. (The backend does the same per
 * read; this one keeps the accumulated series bounded.)
 */
export function downsample(points: readonly TfPoint[], max: number): TfPoint[] {
  const cap = Math.max(4, Math.floor(max));
  if (points.length <= cap) return points.slice();
  const interior = points.slice(1, -1);
  const buckets = Math.max(1, Math.floor((cap - 2) / 2));
  const size = Math.ceil(interior.length / buckets);
  const out: TfPoint[] = [points[0]];
  for (let i = 0; i < interior.length; i += size) {
    let lo = i;
    let hi = i;
    const end = Math.min(i + size, interior.length);
    for (let j = i; j < end; j++) {
      if (interior[j][2] < interior[lo][2]) lo = j;
      if (interior[j][2] > interior[hi][2]) hi = j;
    }
    if (lo === hi) out.push(interior[lo]);
    else out.push(interior[Math.min(lo, hi)], interior[Math.max(lo, hi)]);
  }
  out.push(points[points.length - 1]);
  return out;
}

/** [`mergeSeries`], then thinned if it outgrew [`SERIES_CAP`]. */
export function appendSeries(existing: readonly TfPoint[], incoming: readonly TfPoint[]): TfPoint[] {
  const merged = mergeSeries(existing, incoming);
  return merged.length > SERIES_CAP ? downsample(merged, SERIES_KEEP) : merged;
}

/** One event file's accumulated state. */
export interface FileState {
  cursor: TfCursor | null;
  scalars: Record<string, TfPoint[]>;
  /** Other-kind series seen so far: kind → tag names. */
  series: Record<string, string[]>;
  nonFinite: number;
  oversized: number;
  malformed: number;
  dropped: number;
  badCrc: boolean;
}

export function emptyFileState(): FileState {
  return { cursor: null, scalars: {}, series: {}, nonFinite: 0, oversized: 0, malformed: 0, dropped: 0, badCrc: false };
}

/** Fold one `tfevents_read` answer into the file's state (a new state; no mutation). */
export function applyRead(state: FileState, read: TfReadResult): FileState {
  const base = read.reset ? emptyFileState() : state;
  const scalars: Record<string, TfPoint[]> = { ...base.scalars };
  for (const [tag, points] of Object.entries(read.scalars)) {
    scalars[tag] = appendSeries(scalars[tag] ?? [], points);
  }
  const series: Record<string, string[]> = { ...base.series };
  for (const [kind, tags] of Object.entries(read.skipped.series)) {
    const merged = new Set([...(series[kind] ?? []), ...tags]);
    series[kind] = [...merged].sort();
  }
  return {
    cursor: read.cursor,
    scalars,
    series,
    nonFinite: base.nonFinite + read.skipped.nonFinite,
    oversized: base.oversized + read.skipped.oversized,
    malformed: base.malformed + read.skipped.malformed,
    dropped: base.dropped + read.skipped.dropped,
    // A corrupt record stops the file, so the flag follows the latest read.
    badCrc: read.skipped.badCrc,
  };
}

/**
 * The series of one run from its files (oldest first). On a step both files
 * hold, the later file wins: a restarted job overwrites the steps it redoes.
 */
export function mergeRunFiles(files: readonly FileState[], tag: string): TfPoint[] {
  let out: TfPoint[] = [];
  for (const f of files) {
    const s = f.scalars[tag];
    if (s && s.length) out = mergeSeries(out, s);
  }
  return out;
}

/** Every scalar tag any of the files holds, sorted. */
export function tagsOf(files: readonly FileState[]): string[] {
  const set = new Set<string>();
  for (const f of files) for (const t of Object.keys(f.scalars)) set.add(t);
  return [...set].sort();
}

/** The newest wall time (seconds) of any point, or 0. */
export function newestWall(files: readonly FileState[]): number {
  let newest = 0;
  for (const f of files) {
    for (const s of Object.values(f.scalars)) {
      const last = s[s.length - 1];
      if (last && last[1] > newest) newest = last[1];
    }
  }
  return newest;
}

/** A run is "live" by default when its newest point is under 10 minutes old. */
export const LIVE_WINDOW_MS = 10 * 60 * 1000;

export function isRecent(newestWallSeconds: number, nowMs: number): boolean {
  return newestWallSeconds > 0 && nowMs - newestWallSeconds * 1000 < LIVE_WINDOW_MS;
}

/** Counts of the series the viewer does not draw, per kind. */
export function unshownCounts(files: readonly FileState[]): Array<{ kind: string; count: number }> {
  const byKind = new Map<string, Set<string>>();
  for (const f of files) {
    for (const [kind, tags] of Object.entries(f.series)) {
      const set = byKind.get(kind) ?? new Set<string>();
      for (const t of tags) set.add(t);
      byKind.set(kind, set);
    }
  }
  return [...byKind.entries()]
    .map(([kind, set]) => ({ kind, count: set.size }))
    .sort((a, b) => (a.kind < b.kind ? -1 : 1));
}

// ── Tags ─────────────────────────────────────────────────────────────────

/** The group a tag falls in: its prefix before the first `/`, else `""`. */
export function tagGroup(tag: string): string {
  const i = tag.indexOf("/");
  return i > 0 ? tag.slice(0, i) : "";
}

/**
 * A tag filter: a substring (case-insensitive), or a regular expression when the
 * text starts with `/` (`/loss$` or `/^train/`; a closing `/` is optional).
 * An invalid expression matches nothing and says so.
 */
export function compileTagFilter(text: string): { test: (tag: string) => boolean; invalid: boolean } {
  const q = text.trim();
  if (!q) return { test: () => true, invalid: false };
  if (q.startsWith("/")) {
    const body = q.length > 1 && q.endsWith("/") ? q.slice(1, -1) : q.slice(1);
    if (!body) return { test: () => true, invalid: false };
    try {
      const re = new RegExp(body, "i");
      return { test: (tag) => re.test(tag), invalid: false };
    } catch {
      return { test: () => false, invalid: true };
    }
  }
  const needle = q.toLowerCase();
  return { test: (tag) => tag.toLowerCase().includes(needle), invalid: false };
}

export interface TagGroup {
  /** The prefix; `""` for tags without one. */
  group: string;
  tags: string[];
}

/** Split sorted `tags` into groups by prefix; the unprefixed group comes last. */
export function groupTags(tags: readonly string[]): TagGroup[] {
  const map = new Map<string, string[]>();
  for (const t of tags) {
    const g = tagGroup(t);
    const list = map.get(g);
    if (list) list.push(t);
    else map.set(g, [t]);
  }
  const groups = [...map.entries()].map(([group, list]) => ({ group, tags: list.sort() }));
  groups.sort((a, b) => {
    if (a.group === "" && b.group !== "") return 1;
    if (b.group === "" && a.group !== "") return -1;
    return a.group < b.group ? -1 : a.group > b.group ? 1 : 0;
  });
  return groups;
}

// ── Smoothing ────────────────────────────────────────────────────────────

/**
 * TensorBoard's debiased exponential moving average: `last = last*w +
 * (1-w)*v`, divided by `1 - w^n` so the first points are not dragged to zero.
 * `weight` 0 is the raw line; it is clamped below 1.
 */
export function smooth(points: readonly TfPoint[], weight: number): number[] {
  const w = Math.min(Math.max(weight, 0), 0.999);
  if (w === 0) return points.map((p) => p[2]);
  let last = 0;
  let n = 0;
  const out: number[] = [];
  for (const p of points) {
    last = last * w + (1 - w) * p[2];
    n += 1;
    out.push(last / (1 - Math.pow(w, n)));
  }
  return out;
}

// ── Chart maths ──────────────────────────────────────────────────────────

export type XMode = "step" | "relative" | "wall";

/** The x coordinate of a point: step, seconds since the run's first point, or wall seconds. */
export function xOf(p: TfPoint, mode: XMode, t0: number): number {
  return mode === "step" ? p[0] : mode === "relative" ? p[1] - t0 : p[1];
}

/** A "nice" tick sequence covering [min, max] in about `count` steps. */
export function niceTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  const span = max - min;
  // A span lost in rounding (a smoothed constant is a few ulps off its raw
  // value) is a single value: stepping through it would repeat one tick.
  if (!(span > Math.max(Math.abs(min), Math.abs(max)) * 1e-9)) return [min];
  const rough = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm >= 7 ? 10 : norm >= 3 ? 5 : norm >= 1.5 ? 2 : 1) * mag;
  const first = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = first; v <= max + step * 1e-9; v += step) {
    const tick = Number(v.toPrecision(12));
    if (out[out.length - 1] !== tick) out.push(tick);
    if (out.length > 50) break;
  }
  return out;
}

/** Tick values for a log axis: the powers of ten within the range. */
export function logTicks(min: number, max: number): number[] {
  if (!(min > 0) || !(max > 0)) return [];
  const lo = Math.floor(Math.log10(min));
  const hi = Math.ceil(Math.log10(max));
  const out: number[] = [];
  for (let e = lo; e <= hi && out.length < 20; e++) out.push(Math.pow(10, e));
  return out;
}

/** A value for an axis label or readout: short, but never a lie. */
export function formatValue(v: number): string {
  if (!Number.isFinite(v)) return "";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-3) return v.toExponential(2);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(3).replace(/\.?0+$/, "");
  return Number(v.toPrecision(3)).toString();
}

/** An x-axis label for the chosen mode. */
export function formatX(x: number, mode: XMode): string {
  if (mode === "step") return formatValue(Math.round(x));
  if (mode === "wall") {
    const d = new Date(x * 1000);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return formatDuration(x);
}

/** `1h 02m`, `3m 05s`, `12s` from seconds. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(r).padStart(2, "0")}s`;
  return `${r}s`;
}

/** One line to draw: x/y already in the chart's units. */
export interface Line {
  xs: number[];
  ys: number[];
}

/**
 * The index of the point whose x is nearest `x`, by binary search over the
 * (non-decreasing) `xs`; -1 for an empty line.
 */
export function nearestIndex(xs: readonly number[], x: number): number {
  if (xs.length === 0) return -1;
  let lo = 0;
  let hi = xs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(xs[lo - 1] - x) <= Math.abs(xs[lo] - x)) return lo - 1;
  return lo;
}

/** The extent of several lines; `logY` ignores non-positive y (they cannot be drawn). */
export function extent(
  lines: readonly Line[],
  logY: boolean,
): { x0: number; x1: number; y0: number; y1: number } | null {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const l of lines) {
    for (let i = 0; i < l.xs.length; i++) {
      const y = l.ys[i];
      if (!Number.isFinite(y) || (logY && y <= 0)) continue;
      if (l.xs[i] < x0) x0 = l.xs[i];
      if (l.xs[i] > x1) x1 = l.xs[i];
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;
  return { x0, x1, y0, y1 };
}

/** SVG path data for a line under linear scales; log-scale gaps (y <= 0) break the path. */
export function pathData(
  line: Line,
  sx: (x: number) => number,
  sy: (y: number) => number,
  logY: boolean,
): string {
  let d = "";
  let pen = false;
  for (let i = 0; i < line.xs.length; i++) {
    const y = line.ys[i];
    if (!Number.isFinite(y) || (logY && y <= 0)) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${sx(line.xs[i]).toFixed(1)} ${sy(y).toFixed(1)}`;
    pen = true;
  }
  return d;
}

// ── Run colours ──────────────────────────────────────────────────────────

/** The categorical slots the theme defines (`--tb-series-1..8`). */
export const SERIES_SLOTS = 8;

/**
 * The colour slot and dash of the run at position `index` of the (sorted) run
 * list. A colour follows the run, not its rank among the visible ones, so
 * turning a run off never repaints the rest. A ninth run and beyond reuse the
 * slots with a dashed stroke rather than a generated hue.
 */
export function runStyle(index: number): { slot: number; dash: string | null } {
  const slot = (index % SERIES_SLOTS) + 1;
  const round = Math.floor(index / SERIES_SLOTS);
  return { slot, dash: round === 0 ? null : round === 1 ? "6 3" : "2 3" };
}
