/**
 * Render budget for the in-app diff viewer — pure, no DOM, no React.
 *
 * A lockfile or a vendored-code patch is tens of thousands of lines, and one
 * React row per line freezes WebKitGTK. The viewer therefore renders the
 * first {@link DIFF_LINE_BUDGET} lines (for a whole-file view: a window around
 * the first change) and grows it on request, and it shortens a single very
 * long line (a minified bundle, a base64 blob) instead of letting one row lay
 * out a megabyte of text. The helpers here decide what to render; the
 * component only draws it.
 */
import type { DiffFile, DiffHunk, DiffLine } from "./diff";

/** Lines drawn before the user asks for more. */
export const DIFF_LINE_BUDGET = 1500;
/** Lines one "Show more" adds. */
export const DIFF_LINE_STEP = 3000;
/** Characters of one line drawn before it is shortened. */
export const DIFF_MAX_LINE_CHARS = 2000;
/** Whole-file view: lines drawn above the first change when it opens. */
export const DIFF_LEAD_LINES = 200;

/** Lines of a parsed diff that become rows (hunk headers included). */
export function countDiffLines(files: DiffFile[]): number {
  let n = 0;
  for (const f of files) for (const h of f.hunks) n += h.lines.length;
  return n;
}

export interface CappedDiff {
  files: DiffFile[];
  /** Every row the whole diff would draw. */
  total: number;
  /** Rows kept. */
  shown: number;
}

/**
 * The first `budget` rows of a diff, cut at a line (a hunk may be split).
 * A file that fits whole is returned as the same object, so memoised children
 * keep their identity; a file with nothing left under the budget is dropped.
 */
export function capDiffFiles(files: DiffFile[], budget: number): CappedDiff {
  const total = countDiffLines(files);
  if (total <= budget) return { files, total, shown: total };
  const out: DiffFile[] = [];
  let left = Math.max(0, budget);
  for (const file of files) {
    if (left <= 0) break;
    const fileLines = file.hunks.reduce((n, h) => n + h.lines.length, 0);
    if (fileLines <= left) {
      out.push(file);
      left -= fileLines;
      continue;
    }
    const hunks: DiffHunk[] = [];
    for (const hunk of file.hunks) {
      if (left <= 0) break;
      if (hunk.lines.length <= left) {
        hunks.push(hunk);
        left -= hunk.lines.length;
      } else {
        hunks.push({ ...hunk, lines: hunk.lines.slice(0, left) });
        left = 0;
      }
    }
    out.push({ ...file, hunks });
  }
  return { files: out, total, shown: Math.max(0, budget) };
}

/** A half-open `[start, end)` window over a flat list of rows. */
export interface LineWindow {
  start: number;
  end: number;
}

/** Index of the first added/removed line, or -1 when there is none. */
export function firstChangeIndex(lines: readonly DiffLine[]): number {
  return lines.findIndex((l) => l.type === "add" || l.type === "del");
}

/** The window a whole-file view opens with: `budget` rows starting a little
 *  above `anchor` (the first change), or from the top when it all fits. */
export function initialLineWindow(
  total: number,
  anchor: number,
  budget: number = DIFF_LINE_BUDGET,
): LineWindow {
  if (total <= budget) return { start: 0, end: total };
  const start = Math.min(Math.max(0, anchor - DIFF_LEAD_LINES), total - budget);
  return { start, end: start + budget };
}

/** `w` kept inside `[0, total]` — the file shrank or grew under an open window. */
export function clampLineWindow(w: LineWindow, total: number): LineWindow {
  const end = Math.min(w.end, total);
  return { start: Math.min(w.start, end), end };
}

/** Grow `w` by `step` rows upward or downward, or to the whole list. */
export function growLineWindow(
  w: LineWindow,
  total: number,
  dir: "up" | "down" | "all",
  step: number = DIFF_LINE_STEP,
): LineWindow {
  if (dir === "all") return { start: 0, end: total };
  if (dir === "up") return { start: Math.max(0, w.start - step), end: w.end };
  return { start: w.start, end: Math.min(total, w.end + step) };
}

/** `text` cut to at most `max` characters (never in the middle of a surrogate
 *  pair), with an ellipsis. Returns `text` itself when it fits. */
export function shortenText(text: string, max: number = DIFF_MAX_LINE_CHARS): string {
  if (text.length <= max) return text;
  let cut = max;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}…`;
}

export interface ShortenedLines {
  lines: DiffLine[];
  /** How many lines were cut. */
  shortened: number;
}

/** Every line of `lines` over `max` characters cut (see {@link shortenText});
 *  lines that fit are passed through as the same objects. */
export function shortenLongLines(
  lines: readonly DiffLine[],
  max: number = DIFF_MAX_LINE_CHARS,
): ShortenedLines {
  let shortened = 0;
  const out = lines.map((line) => {
    if (line.text.length <= max) return line;
    shortened += 1;
    return { ...line, text: shortenText(line.text, max) };
  });
  return { lines: out, shortened };
}

/** {@link shortenLongLines} over a capped diff's files. */
export function shortenDiffFiles(
  files: DiffFile[],
  max: number = DIFF_MAX_LINE_CHARS,
): { files: DiffFile[]; shortened: number } {
  let shortened = 0;
  const out = files.map((file) => {
    let touched = false;
    const hunks = file.hunks.map((hunk) => {
      const r = shortenLongLines(hunk.lines, max);
      if (r.shortened === 0) return hunk;
      touched = true;
      shortened += r.shortened;
      return { ...hunk, lines: r.lines };
    });
    return touched ? { ...file, hunks } : file;
  });
  return { files: out, shortened };
}

/** Whether a failed diff request says the folder is not under git — the
 *  backend's `git_diff_file` answers with this phrase (git's own words are
 *  matched too, for an older backend or a remote host's `git`). */
export function isNotARepoError(message: string): boolean {
  return /not a git repository/i.test(message);
}
