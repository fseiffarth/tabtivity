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
import { CHAR_WIDTH, LEADING, type Mark, type PageLayer } from "./layer";

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

/** A mark's extent on the page; a stroke's grows by half its width. */
function boxOf(mark: Mark): Box {
  if (mark.kind === "box") {
    const [x, y, w, h] = mark.rect;
    return { x0: x, y0: y, x1: x + w, y1: y + h };
  }
  if (mark.kind === "text") {
    const rows = mark.text.split("\n");
    const widest = Math.max(...rows.map((row) => [...row].length));
    return { x0: mark.at[0], y0: mark.at[1], x1: mark.at[0] + widest * mark.size * CHAR_WIDTH, y1: mark.at[1] + rows.length * mark.size * LEADING };
  }
  const pad = mark.width / 2;
  const xs = mark.points.map((p) => p[0]);
  const ys = mark.points.map((p) => p[1]);
  return { x0: Math.min(...xs) - pad, y0: Math.min(...ys) - pad, x1: Math.max(...xs) + pad, y1: Math.max(...ys) + pad };
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
  if (spans.length) {
    const words = cut(clean(spans.map(({ line, from, to }) => textOf(line.chars.slice(from, to + 1))).join(" ")), MAX_ANCHOR_WORDS);
    if (!words) return null;
    const how: AnchorHow = mark.kind === "ink" ? strokeHow(box, spans.map((s) => s.line)) : "on";
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
  return { mark: index, how: "at", words, ...(line && line !== words ? { line } : {}) };
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
