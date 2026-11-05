/**
 * Intra-line ("word-level") change marks for the diff viewer.
 *
 * Inside a run of deleted lines followed by added lines, the n-th deleted line
 * is paired with the n-th added one and the two are diffed token by token
 * (words, whitespace runs, single punctuation characters), so the viewer can
 * tint just the part of the line that changed. Marks are half-open ranges of
 * UTF-16 offsets into the line's text (the diff marker excluded).
 *
 * Pure and bounded: a line that is too long, too token-heavy or too unlike its
 * partner gets no marks (the viewer keeps the whole-line tint), and a hunk has
 * a total work budget, so one minified line can never stall the renderer.
 *
 * No DOM, no React.
 */

import type { DiffLine } from "./diff";

/** A changed stretch of a line: UTF-16 offsets `[start, end)` into its text. */
export interface WordMark {
  start: number;
  end: number;
}

/** One piece of a line for rendering: marked pieces are the changed ones. */
export interface TextSegment {
  text: string;
  marked: boolean;
}

/** Lines longer than this (either side) are never word-diffed. */
export const MAX_LINE_CHARS = 2000;
/** Tokens left after trimming the common head and tail, per side. */
export const MAX_TOKENS = 600;
/** Below this similarity of the non-blank text, the pair reads as a rewrite. */
export const MIN_SIMILARITY = 0.4;
/** LCS table cells one hunk may spend in total before it stops pairing. */
export const HUNK_CELL_BUDGET = 3_000_000;

const TOKEN_RE = /[\p{L}\p{N}_]+|\s+|[^\s\p{L}\p{N}_]/gu;

/** Split into word runs, whitespace runs and single punctuation characters. */
export function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

const isBlank = (token: string): boolean => /^\s+$/u.test(token);

/** Offsets of each token, plus the end of the text. */
function offsets(tokens: readonly string[]): number[] {
  const out = new Array<number>(tokens.length + 1);
  let at = 0;
  for (let i = 0; i < tokens.length; i++) {
    out[i] = at;
    at += tokens[i].length;
  }
  out[tokens.length] = at;
  return out;
}

/** `changed[i]` is true for the tokens of `a`/`b` outside the common subsequence. */
function lcsChanged(a: readonly string[], b: readonly string[]): { a: boolean[]; b: boolean[] } {
  const n = a.length;
  const m = b.length;
  const dp = new Uint16Array((n + 1) * (m + 1));
  const w = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ca = new Array<boolean>(n).fill(true);
  const cb = new Array<boolean>(m).fill(true);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ca[i++] = false;
      cb[j++] = false;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return { a: ca, b: cb };
}

/** Marks for the changed tokens: neighbours merge, and a lone blank between two
 *  changed stretches joins them, so `foo bar` -> `baz qux` is one mark. */
function marksOf(tokens: readonly string[], changed: readonly boolean[]): WordMark[] {
  const at = offsets(tokens);
  // Token-index runs [from, to) of changed tokens.
  const runs: { from: number; to: number }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!changed[i]) continue;
    const last = runs[runs.length - 1];
    if (last && last.to === i) last.to = i + 1;
    else if (last && last.to === i - 1 && isBlank(tokens[i - 1])) last.to = i + 1;
    else runs.push({ from: i, to: i + 1 });
  }
  return runs.map((run) => ({ start: at[run.from], end: at[run.to] }));
}

/** True when `marks` span everything but the surrounding blanks. */
function coversAll(text: string, marks: readonly WordMark[]): boolean {
  if (marks.length !== 1) return false;
  const lead = text.length - text.trimStart().length;
  const trail = text.length - text.trimEnd().length;
  return marks[0].start <= lead && marks[0].end >= text.length - trail;
}

/**
 * The changed ranges of `oldText` and `newText`, or null when the pair should
 * stay a plain whole-line change (too long, too many tokens, too dissimilar,
 * or identical).
 */
export function wordMarks(oldText: string, newText: string): { old: WordMark[]; new: WordMark[] } | null {
  const pair = wordMarksCosted(oldText, newText);
  return pair ? pair.marks : null;
}

function wordMarksCosted(
  oldText: string,
  newText: string,
): { marks: { old: WordMark[]; new: WordMark[] } | null; cells: number } {
  const none = { marks: null, cells: 0 };
  if (oldText === newText) return none;
  if (oldText.length > MAX_LINE_CHARS || newText.length > MAX_LINE_CHARS) return none;
  const a = tokenize(oldText);
  const b = tokenize(newText);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailA = a.length;
  let tailB = b.length;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) {
    tailA--;
    tailB--;
  }
  const midA = a.slice(head, tailA);
  const midB = b.slice(head, tailB);
  if (midA.length > MAX_TOKENS || midB.length > MAX_TOKENS) return none;

  const changed =
    midA.length === 0 || midB.length === 0
      ? { a: midA.map(() => true), b: midB.map(() => true) }
      : lcsChanged(midA, midB);
  const cells = (midA.length + 1) * (midB.length + 1);

  // Similarity of the non-blank text: shared characters over all characters.
  let shared = 0;
  let total = 0;
  const count = (tokens: readonly string[], flags?: readonly boolean[]): void => {
    for (let i = 0; i < tokens.length; i++) {
      if (isBlank(tokens[i])) continue;
      total += tokens[i].length;
      if (!flags?.[i]) shared += tokens[i].length;
    }
  };
  count(a.slice(0, head));
  count(a.slice(tailA));
  count(b.slice(0, head));
  count(b.slice(tailB));
  count(midA, changed.a);
  count(midB, changed.b);
  if (total > 0 && shared / total < MIN_SIMILARITY) return { marks: null, cells };

  const flags = (len: number, mid: readonly boolean[], tail: number): boolean[] => [
    ...new Array<boolean>(head).fill(false),
    ...mid,
    ...new Array<boolean>(len - tail).fill(false),
  ];
  const oldMarks = marksOf(a, flags(a.length, changed.a, tailA));
  const newMarks = marksOf(b, flags(b.length, changed.b, tailB));
  const oldOut = coversAll(oldText, oldMarks) ? [] : oldMarks;
  const newOut = coversAll(newText, newMarks) ? [] : newMarks;
  if (oldOut.length === 0 && newOut.length === 0) return { marks: null, cells };
  return { marks: { old: oldOut, new: newOut }, cells };
}

/**
 * Word marks for every pairable line of a hunk, keyed by the line object (so
 * unified and split renderings share one result). A run of `del` lines
 * immediately followed by `add` lines pairs the n-th with the n-th; a
 * `\ No newline` marker between them is ignored. Lines without marks are
 * absent from the map.
 */
export function hunkWordMarks(lines: readonly DiffLine[]): Map<DiffLine, readonly WordMark[]> {
  const result = new Map<DiffLine, readonly WordMark[]>();
  let budget = HUNK_CELL_BUDGET;
  let at = 0;
  while (at < lines.length && budget > 0) {
    if (lines[at].type !== "del") {
      at++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (at < lines.length && (lines[at].type === "del" || lines[at].type === "nonewline")) {
      if (lines[at].type === "del") dels.push(lines[at]);
      at++;
    }
    while (at < lines.length && (lines[at].type === "add" || lines[at].type === "nonewline")) {
      if (lines[at].type === "add") adds.push(lines[at]);
      at++;
    }
    const pairs = Math.min(dels.length, adds.length);
    for (let i = 0; i < pairs && budget > 0; i++) {
      const done = wordMarksCosted(dels[i].text, adds[i].text);
      budget -= done.cells;
      if (!done.marks) continue;
      if (done.marks.old.length > 0) result.set(dels[i], done.marks.old);
      if (done.marks.new.length > 0) result.set(adds[i], done.marks.new);
    }
  }
  return result;
}

/** `text` cut at the mark boundaries, in order, nothing lost. Marks out of
 *  range, empty or overlapping are clamped/ignored rather than trusted. */
export function splitByMarks(text: string, marks: readonly WordMark[] | undefined): TextSegment[] {
  if (!marks || marks.length === 0) return [{ text, marked: false }];
  const out: TextSegment[] = [];
  let at = 0;
  for (const mark of marks) {
    const start = Math.max(at, Math.min(mark.start, text.length));
    const end = Math.min(text.length, mark.end);
    if (end <= start) continue;
    if (start > at) out.push({ text: text.slice(at, start), marked: false });
    out.push({ text: text.slice(start, end), marked: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), marked: false });
  return out.length > 0 ? out : [{ text, marked: false }];
}
