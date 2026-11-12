/**
 * Pure helpers behind "which side is newer" in the sync resolver
 * (`SyncMergeView` -> `CompareView`): dating a change block on each side from
 * git blame, naming the newer side, and spelling a time as absolute + relative.
 * No DOM, no React, no Tauri — the unit-tested half of the resolver's time cues.
 *
 * Clocks: the two sides live on different machines, so a plain mtime comparison
 * can be wrong by their skew. Whole-file "newer" therefore prefers the backend's
 * per-side verdict (which side moved from ITS OWN recorded base) and falls back to
 * the mtimes only when both moved; per-block times are commit/save times as each
 * side reports them and are labelled as such in the UI.
 */

/** The slice of the backend's `GitBlameLine` this needs (structurally compatible). */
export interface BlameEntry {
  line_no: number;
  hash: string;
  short: string;
  author: string;
  /** Author time, unix epoch seconds. */
  author_time: number;
  summary: string;
}

/** When one side's lines of a change block last changed. */
export interface SideTime {
  /** Unix seconds: the newest commit touching the lines, or the file's save time
   *  when any of them is not committed yet. */
  secs: number;
  committed: boolean;
  /** The newest commit (committed blocks only). */
  commit?: { short: string; summary: string; author: string };
}

/** What the resolver knows about one side's age. */
export interface SideInfo {
  /** The file's last-modified time on this side (unix secs), when reported. */
  mtime: number | null;
  /** Per-line blame of this side's text, keyed by 1-based line. null = blame
   *  unavailable (still loading, disconnected, failed): per-block times stay off.
   *  An empty map = nothing committed (not a repo, or a never-committed file). */
  blame: Map<number, BlameEntry> | null;
}

export interface SideTimes {
  left: SideInfo;
  right: SideInfo;
  /** The column whose whole file is newer, if that can be said. */
  newer: "left" | "right" | null;
  /** Why: the backend says only that side moved since the last sync, or its
   *  mtime is later (cross-machine clocks — approximate). */
  newerBasis: "sync" | "time" | null;
}

/** git's "Not Committed Yet" pseudo-commit (all zeros or empty). */
export function isUncommittedHash(hash: string): boolean {
  return hash === "" || /^0+$/.test(hash);
}

/**
 * Date one side of a change block. `lines` are the block's 1-based line numbers
 * on that side. A block with any uncommitted line is dated by the file's save
 * time (uncommitted work is by definition newer than every commit under it); a
 * fully committed one by its newest commit. Null when the side has no lines in
 * the block, blame is off, or nothing honest can be said — never a zero.
 */
export function blockSideTime(
  lines: number[],
  blame: Map<number, BlameEntry> | null,
  fileMtime: number | null,
): SideTime | null {
  if (!blame || lines.length === 0) return null;
  const notCommitted = (): SideTime | null =>
    fileMtime != null && fileMtime > 0 ? { secs: fileMtime, committed: false } : null;
  // Blame answered but covers no line: not a repo / never committed.
  if (blame.size === 0) return notCommitted();
  let newest: BlameEntry | null = null;
  let uncommitted = false;
  let seen = 0;
  for (const n of lines) {
    const e = blame.get(n);
    if (!e) continue;
    seen++;
    if (isUncommittedHash(e.hash)) {
      uncommitted = true;
    } else if (e.author_time > 0 && (!newest || e.author_time > newest.author_time)) {
      newest = e;
    }
  }
  if (seen === 0) return null;
  if (uncommitted) return notCommitted();
  if (!newest) return null;
  return {
    secs: newest.author_time,
    committed: true,
    commit: { short: newest.short, summary: newest.summary, author: newest.author },
  };
}

/** Clock tolerance: two stamps this close are the same moment, not "newer". */
const SAME_MOMENT_SECS = 1;

/** The newer of a block's two sides; null unless both are dated and differ. */
export function newerSide(left: SideTime | null, right: SideTime | null): "left" | "right" | null {
  if (!left || !right) return null;
  const d = left.secs - right.secs;
  if (Math.abs(d) <= SAME_MOMENT_SECS) return null;
  return d > 0 ? "left" : "right";
}

/**
 * Which side holds the newer copy of the whole file: the backend's per-side
 * direction wins (only one side moved from its recorded base), so clock skew
 * cannot flip it; a file both sides changed falls back to the mtime comparison.
 * `local` is the mirror, `host` the remote. Null when a side is missing or the
 * mtimes tie.
 */
export function newerFileSide(f: {
  hostMtime: number | null | undefined;
  localMtime: number | null | undefined;
  hostDiverged: boolean;
  localDiverged: boolean;
}): { side: "local" | "host"; basis: "sync" | "time" } | null {
  if (f.hostMtime == null || f.localMtime == null) return null;
  if (f.hostDiverged !== f.localDiverged) {
    return { side: f.hostDiverged ? "host" : "local", basis: "sync" };
  }
  if (f.hostMtime === f.localMtime) return null;
  return { side: f.hostMtime > f.localMtime ? "host" : "local", basis: "time" };
}

/** A cheap content fingerprint (length + FNV-1a) keying the blame cache, so a
 *  file edited since the last look is blamed afresh. */
export function contentKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${text.length}:${(h >>> 0).toString(16)}`;
}

const MIN = 60;
const HOUR = 3600;
const DAY = 86400;

/** Spell `secs` (unix) relative to `nowMs` in `lang`: "3 hours ago" (`long`) or
 *  "3h ago" (`narrow`, for a button). Pure — the clock is passed in. */
export function relativeWhen(
  secs: number,
  nowMs: number,
  lang: string | undefined,
  style: "long" | "narrow" = "long",
): string {
  const diff = secs - nowMs / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto", style });
  if (abs < MIN) return rtf.format(Math.round(diff), "second");
  if (abs < HOUR) return rtf.format(Math.round(diff / MIN), "minute");
  if (abs < DAY) return rtf.format(Math.round(diff / HOUR), "hour");
  if (abs < 30 * DAY) return rtf.format(Math.round(diff / DAY), "day");
  if (abs < 365 * DAY) return rtf.format(Math.round(diff / (30 * DAY)), "month");
  return rtf.format(Math.round(diff / (365 * DAY)), "year");
}

/** The absolute stamp for a tooltip: locale date + time, to the minute. */
export function absoluteWhen(secs: number, lang: string | undefined): string {
  return new Date(secs * 1000).toLocaleString(lang, { dateStyle: "medium", timeStyle: "short" });
}
