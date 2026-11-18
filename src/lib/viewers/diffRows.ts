/**
 * Pure layout helpers for the diff viewers: the split (before / after) row
 * pairing shared by the Reader's Diffs tab and `DiffView`, the change anchors
 * the viewer's previous / next buttons walk, the fold ranges of a whole-file
 * view, and the per-file facts of the multi-file index. No DOM, no React.
 */
import type { DiffFile, DiffLine } from "./diff";

/** One row of the split view: a before/after pair, or a `note` line (hunk
 *  header, "no newline" marker) spanning both sides. */
export interface SplitRow {
  before?: DiffLine;
  after?: DiffLine;
  note?: string;
  /** Index, in the lines given, of the row's first source line. */
  at: number;
  /** The first row of a run of added / deleted lines — a change anchor. */
  start?: boolean;
}

const isChange = (line: DiffLine): boolean => line.type === "add" || line.type === "del";

/** Pair each contiguous replacement run; keep context and metadata in order. */
export function splitDiffRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at];
    if (isChange(line)) {
      const runStart = at;
      const before: DiffLine[] = [];
      const after: DiffLine[] = [];
      while (at < lines.length && isChange(lines[at])) {
        const item = lines[at++];
        (item.type === "del" ? before : after).push(item);
      }
      const count = Math.max(before.length, after.length);
      for (let index = 0; index < count; index++) {
        rows.push({ before: before[index], after: after[index], at: runStart, ...(index === 0 ? { start: true } : {}) });
      }
    } else {
      rows.push(line.type === "context" ? { before: line, after: line, at } : { note: line.text, at });
      at++;
    }
  }
  return rows;
}

/** Indices of the lines that start a change: the first of each run of added /
 *  deleted lines (the same runs `splitDiffRows` pairs). */
export function changeStarts(lines: readonly DiffLine[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isChange(lines[i]) && (i === 0 || !isChange(lines[i - 1]))) starts.push(i);
  }
  return starts;
}

/** One change in a whole diff: where it sits, and the id its row carries. */
export interface ChangeAnchor {
  file: number;
  hunk: number;
  line: number;
  id: string;
}

/** The id of the change starting at `line` of `hunk` of `file`. */
export function anchorId(file: number, hunk: number, line: number): string {
  return `${file}:${hunk}:${line}`;
}

/** Every change of `files`, in reading order. */
export function changeAnchors(files: readonly Pick<DiffFile, "hunks">[]): ChangeAnchor[] {
  const anchors: ChangeAnchor[] = [];
  files.forEach((file, fi) =>
    file.hunks.forEach((hunk, hi) => {
      for (const li of changeStarts(hunk.lines)) anchors.push({ file: fi, hunk: hi, line: li, id: anchorId(fi, hi, li) });
    }),
  );
  return anchors;
}

/** The next (`dir` 1) or previous (-1) change index out of `count`, wrapping
 *  around. From nothing selected (`current` < 0) next is the first, previous the
 *  last. -1 when there is no change. */
export function stepChange(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return dir === 1 ? 0 : count - 1;
  return (current + dir + count) % count;
}

/** Unchanged lines kept on each side of a change when a whole file is folded. */
export const FOLD_MARGIN = 4;
/** A run of unchanged lines folds only when this many would be hidden. */
export const FOLD_MIN = 6;

/** A fold: `lines[from, to)`, unchanged lines far from any change. */
export interface FoldRange {
  from: number;
  to: number;
}

/**
 * The runs of context to fold in a whole-file view: each stretch of unchanged
 * lines keeps `margin` lines next to a change (none at the file's ends) and
 * folds the rest, if that hides at least `min` lines. A file with no change
 * folds nothing.
 */
export function foldRanges(lines: readonly DiffLine[], margin = FOLD_MARGIN, min = FOLD_MIN): FoldRange[] {
  if (!lines.some((line) => line.type !== "context")) return [];
  const ranges: FoldRange[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== "context") {
      i++;
      continue;
    }
    const start = i;
    while (i < lines.length && lines[i].type === "context") i++;
    const from = start + (start > 0 ? margin : 0);
    const to = i - (i < lines.length ? margin : 0);
    if (to - from >= min) ranges.push({ from, to });
  }
  return ranges;
}

/** A stretch of a hunk's lines: shown as they are, or one fold. */
export interface FoldSegment {
  fold: boolean;
  from: number;
  to: number;
}

/** `lines` cut at `ranges` into shown stretches and folds, in order. */
export function foldSegments(length: number, ranges: readonly FoldRange[]): FoldSegment[] {
  const segments: FoldSegment[] = [];
  let at = 0;
  for (const range of ranges) {
    if (range.from > at) segments.push({ fold: false, from: at, to: range.from });
    segments.push({ fold: true, from: range.from, to: range.to });
    at = range.to;
  }
  if (at < length) segments.push({ fold: false, from: at, to: length });
  return segments;
}

/** The `+` / `−` line counts of a file's hunks. */
export function fileStats(file: Pick<DiffFile, "hunks">): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "add") added++;
      else if (line.type === "del") removed++;
    }
  }
  return { added, removed };
}

/** A file's name for the header and the index: its path, and the path it was
 *  renamed from, if any. A deleted file shows its old path. */
export function fileLabel(file: Pick<DiffFile, "oldPath" | "newPath">): { path: string; from?: string } {
  const gone = "/dev/null";
  if (!file.newPath || file.newPath === gone) return { path: file.oldPath };
  if (file.oldPath && file.oldPath !== gone && file.oldPath !== file.newPath) {
    return { path: file.newPath, from: file.oldPath };
  }
  return { path: file.newPath };
}

/**
 * The `scrollTop` that brings an element into view in its scroller: centred
 * (`"center"`, a change) or at the top (`"start"`, a file). The tops are
 * viewport coordinates; the result is never negative.
 */
export function scrollTopFor(
  align: "center" | "start",
  scroller: { top: number; scrollTop: number; height: number },
  el: { top: number; height: number },
): number {
  const inside = el.top - scroller.top + scroller.scrollTop;
  const target = align === "start" ? inside : inside - (scroller.height - el.height) / 2;
  return Math.max(0, Math.round(target));
}
