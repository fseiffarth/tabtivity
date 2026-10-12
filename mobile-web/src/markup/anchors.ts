/**
 * What each mark is on: the page's own words under a stroke or a box, or
 * beside a note in the margin, read off the page's text runs. Sent with the
 * marks so the agent can look the words up in the sources straight away
 * instead of reading them off a picture first (`markup.rs`, `Anchor`).
 *
 * Pure: the phone runs it on the runs the sealed frame answers (`text`), the
 * desktop on `pageText.ts`'s. Places are approximate — a run's width is
 * spread evenly over its characters — which is enough to pick words, and the
 * agent sees the page picture beside them. The text is the PDF's, so it is
 * cleaned to one plain line and bounded here, and again by the desktop.
 */

import type { TextRun } from "./findText";
import { markBox, round, type Mark, type MarkColor, type PageLayer, type StampMark } from "./layer";

export type AnchorHow = "through" | "under" | "around" | "at" | "on" | "beside";
export type Anchor = { mark: number; how: AnchorHow; words: string; line?: string };

/** The desktop's bounds (`MAX_ANCHOR_WORDS`, `MAX_ANCHOR_LINE`), in characters. */
export const MAX_ANCHOR_WORDS = 200;
export const MAX_ANCHOR_LINE = 300;

type Box = { x0: number; y0: number; x1: number; y1: number };
type Char = { ch: string; x0: number; x1: number };
/** One line of text: a band of runs side by side, its characters in order. */
type Line = { y0: number; y1: number; h: number; chars: Char[] };

const SPACE = /\s/u;

/** One plain line: control characters and runs of white space become one space. */
function clean(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/gu, " ").trim();
}

/** `text` cut to `max` characters, the cut marked. */
function cut(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** The runs grouped into lines: runs whose middles sit within half a line of
 * each other, split where a gap is wide enough to be a column's gutter. */
function linesOf(runs: readonly TextRun[]): Line[] {
  const usable = runs.filter((run) => run.str && [run.x, run.y, run.w, run.h].every(Number.isFinite) && run.h > 0 && run.w >= 0);
  const sorted = [...usable].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x);
  const bands: TextRun[][] = [];
  for (const run of sorted) {
    const band = bands[bands.length - 1];
    const last = band?.[0];
    if (last && Math.abs(run.y + run.h / 2 - (last.y + last.h / 2)) < Math.min(run.h, last.h) / 2) band.push(run);
    else bands.push([run]);
  }
  const lines: Line[] = [];
  for (const band of bands) {
    band.sort((a, b) => a.x - b.x);
    let line: Line | null = null;
    let end = -Infinity;
    for (const run of band) {
      const gap = run.x - end;
      if (!line || gap > 2.5 * run.h) {
        line = { y0: run.y, y1: run.y + run.h, h: run.h, chars: [] };
        lines.push(line);
      } else {
        line.y0 = Math.min(line.y0, run.y);
        line.y1 = Math.max(line.y1, run.y + run.h);
        line.h = Math.max(line.h, run.h);
        const before = line.chars[line.chars.length - 1]?.ch ?? " ";
        if (gap > 0.15 * run.h && !SPACE.test(before) && !SPACE.test(run.str[0])) line.chars.push({ ch: " ", x0: end, x1: run.x });
      }
      const chars = [...run.str];
      const each = run.w / chars.length;
      chars.forEach((ch, i) => line!.chars.push({ ch, x0: run.x + each * i, x1: run.x + each * (i + 1) }));
      end = Math.max(end, run.x + run.w);
    }
  }
  return lines;
}

/** `from`..`to` (character indices) widened to whole words. */
function wordSpan(chars: Char[], from: number, to: number): [number, number] {
  while (from > 0 && !SPACE.test(chars[from - 1].ch)) from--;
  while (to < chars.length - 1 && !SPACE.test(chars[to + 1].ch)) to++;
  return [from, to];
}

const textOf = (chars: Char[]) => clean(chars.map((c) => c.ch).join(""));

/** The line around `[from, to]`, cut to the bound around the span. */
function context(line: Line, from: number, to: number): string {
  const whole = textOf(line.chars);
  if ([...whole].length <= MAX_ANCHOR_LINE) return whole;
  const room = Math.max(0, Math.floor((MAX_ANCHOR_LINE - (to - from + 1)) / 2) - 1);
  const start = Math.max(0, from - room);
  const stop = Math.min(line.chars.length, to + 1 + room);
  return cut(`${start > 0 ? "…" : ""}${textOf(line.chars.slice(start, stop))}${stop < line.chars.length ? "…" : ""}`, MAX_ANCHOR_LINE);
}

/** A mark's extent on the page; a stroke's grows by half its width. A
 * stamp's is the middle band of its symbol (`stampBox`). */
function boxOf(mark: Mark): Box {
  if (mark.kind === "box" || mark.kind === "text") {
    const [x, y, w, h] = markBox(mark);
    return { x0: x, y0: y, x1: x + w, y1: y + h };
  }
  if (mark.kind === "stamp") return stampBox(mark);
  const pad = mark.width / 2;
  const xs = mark.points.map((p) => p[0]);
  const ys = mark.points.map((p) => p[1]);
  return { x0: Math.min(...xs) - pad, y0: Math.min(...ys) - pad, x1: Math.max(...xs) + pad, y1: Math.max(...ys) + pad };
}

/** What a stamp is on: a stamp is sized for a finger, often taller than a
 * line, so only a thin band through its middle counts — a cross on a word is
 * on that word, not on the lines above and below it. */
function stampBox(mark: StampMark): Box {
  const [x, y] = mark.at;
  return { x0: x - 0.4 * mark.size, y0: y - 0.1 * mark.size, x1: x + 0.4 * mark.size, y1: y + 0.1 * mark.size };
}

/** How a stamp sits on its words: a caret or a pilcrow marks a place, a cross
 * or the swap arrows the words themselves. */
function stampHow(mark: StampMark): AnchorHow {
  return mark.symbol === "insert" || mark.symbol === "paragraph" ? "at" : "on";
}

/** The words of each line `box` covers enough of, widened to whole words —
 * `below` lines' heights under a line still count as on it. */
function spansUnder(box: Box, lines: Line[], below: number): { line: Line; from: number; to: number }[] {
  const spans: { line: Line; from: number; to: number }[] = [];
  for (const line of lines) {
    // Enough of the mark on the line's band: a circle's rim grazing the line
    // above is not on it, a thin stroke wholly inside is.
    const overlap = Math.min(box.y1, line.y1 + below * line.h) - Math.max(box.y0, line.y0);
    if (overlap <= 0 || overlap < Math.min(0.25 * line.h, 0.8 * (box.y1 - box.y0))) continue;
    let from = -1;
    let to = -1;
    line.chars.forEach((c, i) => {
      const middle = (c.x0 + c.x1) / 2;
      if (SPACE.test(c.ch) || middle < box.x0 || middle > box.x1) return;
      if (from < 0) from = i;
      to = i;
    });
    if (from < 0) continue;
    const [start, stop] = wordSpan(line.chars, from, to);
    spans.push({ line, from: start, to: stop });
  }
  return spans;
}

/** The words of `spans`, one plain bounded line. */
function spanWords(spans: { line: Line; from: number; to: number }[]): string {
  return cut(clean(spans.map(({ line, from, to }) => textOf(line.chars.slice(from, to + 1))).join(" ")), MAX_ANCHOR_WORDS);
}

/** How a stroke sits on the words it covers, `hit` being their lines. */
function strokeHow(box: Box, hit: Line[]): AnchorHow {
  const h = hit[0].h;
  const height = box.y1 - box.y0;
  const width = box.x1 - box.x0;
  if (hit.length === 1 && height < 0.6 * h && width > 1.5 * height) {
    // A run's box is ascent over descent, the baseline 0.8 of the way down.
    return (box.y0 + box.y1) / 2 - hit[0].y0 > 0.78 * hit[0].h ? "under" : "through";
  }
  if (width < 1.2 * h && height < 2 * h) return "at";
  if (height >= 1.1 * h && box.y0 <= hit[0].y0 && box.y1 >= hit[hit.length - 1].y1) return "around";
  return "on";
}

/** The words `mark` is on, or beside; `null` when no text is near it. */
function anchorFor(mark: Mark, index: number, lines: Line[]): Anchor | null {
  const box = boxOf(mark);
  // A line under the words sits just below their box.
  const below = mark.kind === "ink" ? 0.35 : 0;
  // A caret or a pilcrow marks the gap between two words, which the "small
  // stroke between two words" reading below finds; only a cross or the swap
  // arrows are on the words under them.
  const spans = mark.kind === "stamp" && stampHow(mark) === "at" ? [] : spansUnder(box, lines, below);
  if (spans.length) {
    const words = spanWords(spans);
    if (!words) return null;
    const how: AnchorHow = mark.kind === "ink" ? strokeHow(box, spans.map((s) => s.line)) : mark.kind === "stamp" ? stampHow(mark) : "on";
    const one = spans.length === 1 ? spans[0] : null;
    const line = one ? context(one.line, one.from, one.to) : "";
    return { mark: index, how, words, ...(line && line !== words ? { line } : {}) };
  }
  // Nothing under it: a note in the margin, or a caret between lines, is
  // about the nearest line beside it.
  const middle = mark.kind === "text" ? mark.at[1] + mark.size / 2 : (box.y0 + box.y1) / 2;
  let near: Line | null = null;
  let distance = Infinity;
  for (const line of lines) {
    const d = Math.abs((line.y0 + line.y1) / 2 - middle);
    if (d < distance) { near = line; distance = d; }
  }
  if (!near || distance > 1.5 * near.h) return null;
  if (mark.kind === "text") {
    const words = cut(textOf(near.chars), MAX_ANCHOR_WORDS);
    return words ? { mark: index, how: "beside", words } : null;
  }
  // A small stroke between two words: those two.
  const x = (box.x0 + box.x1) / 2;
  const after = near.chars.findIndex((c) => !SPACE.test(c.ch) && c.x0 >= x);
  let before = (after < 0 ? near.chars.length : after) - 1;
  while (before >= 0 && SPACE.test(near.chars[before].ch)) before--;
  const left = before >= 0 ? wordSpan(near.chars, before, before) : null;
  const right = after >= 0 ? wordSpan(near.chars, after, after) : null;
  if (!left && !right) return null;
  const from = left ? left[0] : right![0];
  const to = right ? right[1] : left![1];
  const words = cut(textOf(near.chars.slice(from, to + 1)), MAX_ANCHOR_WORDS);
  if (!words) return null;
  const line = context(near, from, to);
  return { mark: index, how: mark.kind === "stamp" ? stampHow(mark) : "at", words, ...(line && line !== words ? { line } : {}) };
}

/** What each mark on `page` is on, given the page's text runs (page points
 * from the top left, the marks' own units). Marks with no text near them
 * get none. */
export function anchorsFor(page: PageLayer, runs: readonly TextRun[]): Anchor[] {
  const lines = linesOf(runs);
  if (!lines.length) return [];
  const anchors: Anchor[] = [];
  page.marks.forEach((mark, index) => {
    const anchor = anchorFor(mark, index, lines);
    if (anchor) anchors.push(anchor);
  });
  return anchors;
}

/** What a drag of the text-mark tool makes (`textMarks`). */
export type TextMarkMode = "strike" | "underline" | "highlight";

/** How far a drag's end may sit from a line and still pick it, in that
 * line's heights. */
const PICK_REACH = 0.75;

/** The line a drag's end is on, or the nearest within `PICK_REACH` of one
 * (its horizontal span widened alike); `null` away from any text. */
function lineAt(lines: Line[], x: number, y: number): Line | null {
  let best: Line | null = null;
  let distance = Infinity;
  for (const line of lines) {
    const left = line.chars[0]?.x0 ?? 0;
    const right = line.chars[line.chars.length - 1]?.x1 ?? 0;
    const reach = PICK_REACH * line.h;
    const dy = y < line.y0 ? line.y0 - y : y > line.y1 ? y - line.y1 : 0;
    const dx = x < left ? left - x : x > right ? x - right : 0;
    if (dy > reach || dx > 2 * reach) continue;
    const d = Math.hypot(dx, dy);
    if (d < distance) { best = line; distance = d; }
  }
  return best;
}

/** The first (`end` false) or last word character at or past `x` on a line,
 * clamped to its ends; -1 on a line with no word. */
function charAt(line: Line, x: number, end: boolean): number {
  const words = line.chars.map((c, i) => (SPACE.test(c.ch) ? -1 : i)).filter((i) => i >= 0);
  if (!words.length) return -1;
  if (end) {
    for (let k = words.length - 1; k >= 0; k--) if (line.chars[words[k]].x0 <= x) return words[k];
    return words[0];
  }
  for (const i of words) if (line.chars[i].x1 >= x) return i;
  return words[words.length - 1];
}

/** `[from, to]` on a line with its spaces trimmed off both ends; `null`
 * when only space is left. */
function trimmed(line: Line, from: number, to: number): [number, number] | null {
  while (from <= to && SPACE.test(line.chars[from].ch)) from++;
  while (to >= from && SPACE.test(line.chars[to].ch)) to--;
  return from <= to ? [from, to] : null;
}

/** The marks a drag from `from` to `to` makes over the page's words, snapped
 * to whole words and their lines, the way a text selection runs: from the
 * word at the drag's start to the end of its line, every line between that
 * shares the column, and the last line up to the word at the drag's end. Per
 * line, a highlighter box over its words (`highlight`), or a straight even
 * pen stroke `width` wide through them (`strike`, at 0.55 of the line's
 * height) or under them (`underline`, at 0.9). `[]` when no text is near
 * either end. */
export function textMarks(
  runs: readonly TextRun[],
  from: [number, number],
  to: [number, number],
  mode: TextMarkMode,
  color: MarkColor,
  width: number,
): Mark[] {
  const lines = linesOf(runs);
  const start = lineAt(lines, from[0], from[1]);
  const stop = lineAt(lines, to[0], to[1]);
  if (!start || !stop) return [];
  const order = (line: Line) => (line.y0 + line.y1) / 2;
  // Reading order: a drag up the page selects the same words as one down it.
  let [a, b, ax, bx] = [start, stop, from[0], to[0]];
  if (order(b) < order(a) - Math.min(a.h, b.h) / 2 || (a === b && bx < ax)) [a, b, ax, bx] = [b, a, bx, ax];
  const left = Math.min(a.chars[0].x0, b.chars[0].x0);
  const right = Math.max(a.chars[a.chars.length - 1].x1, b.chars[b.chars.length - 1].x1);
  const spans: { line: Line; from: number; to: number }[] = [];
  const take = (line: Line, first: number, last: number) => {
    if (first < 0 || last < 0 || last < first) return;
    const [wordFrom, wordTo] = wordSpan(line.chars, first, last);
    const kept = trimmed(line, wordFrom, wordTo);
    if (kept) spans.push({ line, from: kept[0], to: kept[1] });
  };
  if (a === b) take(a, charAt(a, ax, false), charAt(a, bx, true));
  else {
    take(a, charAt(a, ax, false), a.chars.length - 1);
    // Between them: the lines of the same column — another column's lines
    // at the same height are not part of the run.
    lines
      .filter((line) => line !== a && line !== b && order(line) > order(a) && order(line) < order(b)
        && line.chars[0].x0 < right && line.chars[line.chars.length - 1].x1 > left)
      .sort((p, q) => order(p) - order(q))
      .forEach((line) => take(line, 0, line.chars.length - 1));
    take(b, 0, charAt(b, bx, true));
  }
  return spans.flatMap(({ line, from: first, to: last }): Mark[] => {
    const x0 = round(line.chars[first].x0);
    const x1 = round(line.chars[last].x1);
    if (x1 <= x0) return [];
    if (mode === "highlight") {
      const h = round(line.y1 - line.y0);
      return h > 0 ? [{ kind: "box", color, rect: [x0, round(line.y0), round(x1 - x0), h] }] : [];
    }
    const y = round(line.y0 + (mode === "strike" ? 0.55 : 0.9) * line.h);
    return [{ kind: "ink", color, width, points: [[x0, y, 0.5], [x1, y, 0.5]] }];
  });
}

/** The page's words under a box (page units `[x, y, w, h]`), whole words, one
 * plain bounded line — `""` when none. A ✓ group's caption compares these
 * before Submit and after the reload. */
export function wordsIn(runs: readonly TextRun[], box: [number, number, number, number]): string {
  const [x, y, w, h] = box;
  return spanWords(spansUnder({ x0: Math.min(x, x + w), y0: Math.min(y, y + h), x1: Math.max(x, x + w), y1: Math.max(y, y + h) }, linesOf(runs), 0));
}
