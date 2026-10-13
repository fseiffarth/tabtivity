/**
 * The markup layer: what the reader drew over a PDF's pages or a picture,
 * as vectors in each page's own units (`docs/mobile_pdf_markup_plan.md`
 * §2.1). A PDF page's units are its points as displayed — after its
 * `/Rotate`, origin top left; a picture's are its pixels. The same numbers
 * draw on the phone (`rasterize.ts`) and bake into the desktop's marked copy
 * (`markup.rs`), whose wire shape this mirrors.
 *
 * Everything here is pure: the view keeps a `History` and replaces it.
 */

export type MarkColor = "red" | "blue" | "black" | "yellow";
export const MARK_COLORS: readonly MarkColor[] = ["red", "blue", "black", "yellow"];

/** How a pen stroke is drawn: `pen` follows the stylus's pressure; `marker`
 * is a wide see-through highlighter; `dashed` a broken line; `arrow` an even
 * line with an open head at its end. The other styles draw at the base width. */
export type PenStyle = "pen" | "marker" | "dashed" | "arrow";
export const PEN_STYLES: readonly PenStyle[] = ["pen", "marker", "dashed", "arrow"];

/** A pen stroke: `[x, y, pressure]` samples and its base width. `style` is
 * left out for the plain pen — what every stroke was before styles, and what
 * an older desktop (`markup::Mark` refuses unknown fields) still takes.
 * `comment`, the reader's words about the mark (`setComment`), is left out
 * when there is none, for the same reason. */
export type InkMark = { kind: "ink"; color: MarkColor; width: number; points: [number, number, number][]; style?: PenStyle; comment?: string };
/** A highlighter box: `[x, y, width, height]`. */
export type BoxMark = { kind: "box"; color: MarkColor; rect: [number, number, number, number]; comment?: string };
/** A typed note, anchored at its top-left corner; `\n` breaks lines. It says
 * what it wants in its own words, so it takes no comment. */
export type TextMark = { kind: "text"; color: MarkColor; at: [number, number]; size: number; text: string };

/** The proofreader's symbols a stamp places with one tap: a caret (insert
 * here), a cross (delete this), a pilcrow (new paragraph) and a pair of
 * arrows (swap these). */
export type StampSymbol = "insert" | "delete" | "paragraph" | "swap";
export const STAMP_SYMBOLS: readonly StampSymbol[] = ["insert", "delete", "paragraph", "swap"];
/** A stamp's line width, as a share of its size. */
export const STAMP_WIDTH = 0.09;
/** Each symbol as unit polylines — x and y in −0.5…0.5 around the stamp's
 * `at`, y down — drawn at `size` units with lines `size × STAMP_WIDTH` wide
 * and round caps. The desktop bakes the same polylines into the marked PDF
 * (`markup_pdf::stamp_shape`), so keep the two in step. */
export const STAMP_SHAPES: Record<StampSymbol, [number, number][][]> = {
  insert: [[[-0.35, 0.4], [0, -0.3], [0.35, 0.4]]],
  delete: [[[-0.4, -0.4], [0.4, 0.4]], [[0.4, -0.4], [-0.4, 0.4]]],
  paragraph: [
    [[0.35, -0.45], [-0.15, -0.45], [-0.32, -0.38], [-0.4, -0.25], [-0.4, -0.15], [-0.32, -0.02], [-0.15, 0.05], [0.05, 0.05]],
    [[0.05, -0.45], [0.05, 0.45]],
    [[0.3, -0.45], [0.3, 0.45]],
  ],
  swap: [
    [[-0.4, -0.2], [0.4, -0.2]],
    [[0.2, -0.38], [0.4, -0.2], [0.2, -0.02]],
    [[0.4, 0.2], [-0.4, 0.2]],
    [[-0.2, 0.02], [-0.4, 0.2], [-0.2, 0.38]],
  ],
};
/** A proofreading stamp, centred on `at`, `size` units across. */
export type StampMark = { kind: "stamp"; color: MarkColor; at: [number, number]; size: number; symbol: StampSymbol; comment?: string };
export type Mark = InkMark | BoxMark | TextMark | StampMark;

/** The longest comment a mark takes, in characters (`markup::MAX_COMMENT`). */
export const MAX_COMMENT = 500;

/** A new stamp's size on a page `pageWidth` units wide: about a line and a
 * half of body text on A4, within the desktop's bound. */
export function stampSize(pageWidth: number): number {
  return Math.min(200, Math.max(4, Math.round(pageWidth / 30)));
}

/** A stamp's polylines in page units. */
export function stampLines(mark: StampMark): [number, number][][] {
  return STAMP_SHAPES[mark.symbol].map((line) => line.map(([x, y]): [number, number] => [mark.at[0] + x * mark.size, mark.at[1] + y * mark.size]));
}

/** One page's marks and the size they are measured in. */
export type PageLayer = { size: [number, number]; marks: Mark[] };
/** One Submit's marks exactly as it sent them, page by page in the order of
 * that page's `marks` in the request — what the agent's ticks
 * (`markup_done`: round id, page, 1-based mark) index into
 * (`docs/markup_tick_approve_plan.md` §3). The marks are the sent side's own
 * objects, shared, not copies. `words`: per page, by index in that page's
 * logged marks, the page's words under each mark at Submit (`null` where
 * none were read) — what a ✓ group's "was … now …" caption compares the
 * reloaded page against. Absent from records written before it. */
export type SentRound = { id: string; pages: Record<number, Mark[]>; words?: Record<number, (string | null)[]> };
/** The marks earlier Submits sent, drawn dimmed and never sent again
 * (`docs/pdf_markup_rounds_plan.md` §2.1), and how many rounds went out.
 * Only the reader removes them (eraser, Clear page, Clear all marks, Clear
 * sent marks, approving a ticked mark). `log`: the newest rounds that went
 * out with a round id (`MAX_LOGGED_ROUNDS`), oldest first — absent from
 * records written before ticks. */
export type SentLayer = { pages: Record<number, PageLayer>; rounds: number; log?: SentRound[] };
/** Every marked page, by 1-based page number. `pages` holds only the marks
 * not yet sent — what notes, undo and Submit see — so sent marks never go
 * out twice; the eraser and Clear page reach them only when asked. No flag rides on a mark: the
 * desktop's `markup::Mark` refuses unknown fields. */
export type Layer = { pages: Record<number, PageLayer>; sent?: SentLayer };

export const EMPTY_LAYER: Layer = { pages: {} };

/** The desktop's ceilings (`markup.rs`), checked before a mark is added so a
 * layer the phone holds is always one the desktop accepts. */
export const LIMITS = { marks: 5_000, points: 200_000, pageText: 2_000 } as const;

/** Text notes' line height and assumed character width, in multiples of the
 * font size — the desktop sizes the note's box the same way. */
export const LEADING = 1.2;
export const CHAR_WIDTH = 0.72;

/** A stroke's width at one sample: `0.5` pressure (a finger, a mouse) draws
 * the base width. The desktop's `markup::ink_width` is the same formula. */
export function inkWidth(base: number, pressure: number): number {
  return base * (0.3 + 1.4 * Math.min(1, Math.max(0, pressure)));
}

/** How long an arrow's head is, in multiples of its width, and how far each
 * side opens from the shaft (radians). The desktop's `markup_pdf::arrow_head`
 * draws the same head. */
export const ARROW_HEAD = 5;
export const ARROW_SPREAD = 0.5;

/** An arrow's open head, `[wing, tip, wing]`: at the stroke's last sample,
 * pointing the way the stroke ran over its last head's length. `null` for a
 * stroke that never moved. */
export function arrowHead(points: readonly (readonly number[])[], width: number): [number, number][] | null {
  if (points.length < 2) return null;
  const tip = points[points.length - 1];
  const length = Math.max(1, width * ARROW_HEAD);
  let back = points[points.length - 2];
  for (let i = points.length - 2; i >= 0; i--) {
    back = points[i];
    if (Math.hypot(tip[0] - back[0], tip[1] - back[1]) >= length) break;
  }
  const dx = tip[0] - back[0];
  const dy = tip[1] - back[1];
  const run = Math.hypot(dx, dy);
  if (run === 0) return null;
  const angle = Math.atan2(dy, dx);
  const wing = (side: number): [number, number] => [
    tip[0] - length * Math.cos(angle + side * ARROW_SPREAD),
    tip[1] - length * Math.sin(angle + side * ARROW_SPREAD),
  ];
  return [wing(1), [tip[0], tip[1]], wing(-1)];
}

/** A coordinate as stored: a tenth of a unit is finer than any pen. */
export function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Keeps a point on the page — a stroke that runs off the edge ends there. */
export function clampToPage(x: number, y: number, size: [number, number]): [number, number] {
  return [Math.min(size[0], Math.max(0, x)), Math.min(size[1], Math.max(0, y))];
}

function distanceToSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Ramer–Douglas–Peucker on a stroke's samples, keeping each kept sample's
 * pressure: handwriting stays handwriting at a fraction of the points. */
export function simplify(points: [number, number, number][], tolerance: number): [number, number, number][] {
  if (points.length <= 2) return points.slice();
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    let worst = -1;
    let at = -1;
    for (let i = first + 1; i < last; i++) {
      const d = distanceToSegment([points[i][0], points[i][1]], [points[first][0], points[first][1]], [points[last][0], points[last][1]]);
      if (d > worst) { worst = d; at = i; }
    }
    if (at > 0 && worst > tolerance) {
      keep[at] = true;
      stack.push([first, at], [at, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** A finished stroke as stored: rounded, simplified, on the page. */
export function finishStroke(mark: InkMark, size: [number, number]): InkMark {
  const placed = mark.points.map(([x, y, p]): [number, number, number] => {
    const [cx, cy] = clampToPage(x, y, size);
    return [round(cx), round(cy), Math.round(p * 100) / 100];
  });
  // Half the base width is below what the eye tells apart at that width.
  return { ...mark, points: simplify(placed, Math.max(0.15, mark.width * 0.15)) };
}

/** The box a text note covers — the same estimate the desktop sizes its
 * annotation by. */
export function textBox(mark: TextMark): [number, number, number, number] {
  const lines = mark.text.split("\n");
  const widest = Math.max(1, ...lines.map((line) => [...line].length));
  return [mark.at[0], mark.at[1], widest * mark.size * CHAR_WIDTH, lines.length * mark.size * LEADING];
}

/** The note under `(x, y)` on a page — the topmost, as drawn last — or -1. */
export function noteAt(page: PageLayer | undefined, x: number, y: number): number {
  const marks = page?.marks ?? [];
  for (let i = marks.length - 1; i >= 0; i--) {
    const mark = marks[i];
    if (mark.kind !== "text") continue;
    const [bx, by, bw, bh] = textBox(mark);
    if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) return i;
  }
  return -1;
}

/** A note moved to `at`, kept on the page as far as it fits. */
export function moveNote(mark: TextMark, at: [number, number], size: [number, number]): TextMark {
  const [, , w, h] = textBox(mark);
  const x = Math.min(Math.max(0, size[0] - w), Math.max(0, at[0]));
  const y = Math.min(Math.max(0, size[1] - h), Math.max(0, at[1]));
  return { ...mark, at: [round(x), round(y)] };
}

export function markCount(layer: Layer): { marks: number; points: number } {
  let marks = 0;
  let points = 0;
  for (const page of Object.values(layer.pages)) {
    marks += page.marks.length;
    for (const mark of page.marks) if (mark.kind === "ink") points += mark.points.length;
  }
  return { marks, points };
}

function pageText(page: PageLayer | undefined): number {
  return (page?.marks ?? []).reduce((sum, mark) => sum + (mark.kind === "text" ? [...mark.text].length : 0), 0);
}

/** Whether `mark` still fits under the desktop's ceilings. */
export function canAdd(layer: Layer, n: number, mark: Mark): boolean {
  const { marks, points } = markCount(layer);
  if (marks + 1 > LIMITS.marks) return false;
  if (mark.kind === "ink" && points + mark.points.length > LIMITS.points) return false;
  if (mark.kind === "text" && pageText(layer.pages[n]) + [...mark.text].length > LIMITS.pageText) return false;
  return true;
}

/** Whether the note at `index` on page `n` may become `mark` — an edited
 * note counts against the page's text in place of the one it replaces. */
export function canReplace(layer: Layer, n: number, index: number, mark: Mark): boolean {
  if (mark.kind !== "text") return true;
  const page = layer.pages[n];
  const replaced = page?.marks[index];
  const before = pageText(page) - (replaced?.kind === "text" ? [...replaced.text].length : 0);
  return before + [...mark.text].length <= LIMITS.pageText;
}

export function addMark(layer: Layer, n: number, size: [number, number], mark: Mark): Layer {
  const page = layer.pages[n] ?? { size, marks: [] };
  return { ...layer, pages: { ...layer.pages, [n]: { size: page.size, marks: [...page.marks, mark] } } };
}

/** Several marks added to page `n` at once — the marks one text-mark drag
 * makes, a line each — as one step. */
export function addMarks(layer: Layer, n: number, size: [number, number], marks: readonly Mark[]): Layer {
  if (!marks.length) return layer;
  const page = layer.pages[n] ?? { size, marks: [] };
  return { ...layer, pages: { ...layer.pages, [n]: { size: page.size, marks: [...page.marks, ...marks] } } };
}

/** Whether all of `marks` still fit under the desktop's ceilings together. */
export function canAddAll(layer: Layer, n: number, marks: readonly Mark[]): boolean {
  const { marks: count, points } = markCount(layer);
  if (count + marks.length > LIMITS.marks) return false;
  const added = marks.reduce((sum, mark) => sum + (mark.kind === "ink" ? mark.points.length : 0), 0);
  if (points + added > LIMITS.points) return false;
  const text = marks.reduce((sum, mark) => sum + (mark.kind === "text" ? [...mark.text].length : 0), 0);
  return text === 0 || pageText(layer.pages[n]) + text <= LIMITS.pageText;
}

/** Replaces the mark at `index` on page `n` — an edited note. An empty
 * replacement removes it. */
export function replaceMark(layer: Layer, n: number, index: number, mark: Mark | null): Layer {
  const page = layer.pages[n];
  if (!page || index < 0 || index >= page.marks.length) return layer;
  const marks = page.marks.slice();
  if (mark) marks.splice(index, 1, mark);
  else marks.splice(index, 1);
  return withPage(layer, n, { ...page, marks });
}

function withPage(layer: Layer, n: number, page: PageLayer): Layer {
  const pages = { ...layer.pages };
  if (page.marks.length) pages[n] = page;
  else delete pages[n];
  return { ...layer, pages };
}

/** Whether a mark lies within `radius` of `(x, y)`. */
export function touches(mark: Mark, x: number, y: number, radius: number): boolean {
  if (mark.kind === "ink") {
    const reach = radius + inkWidth(mark.width, 1) / 2;
    if (mark.points.length === 1) return Math.hypot(mark.points[0][0] - x, mark.points[0][1] - y) <= reach;
    for (let i = 1; i < mark.points.length; i++) {
      const a = mark.points[i - 1];
      const b = mark.points[i];
      if (distanceToSegment([x, y], [a[0], a[1]], [b[0], b[1]]) <= reach) return true;
    }
    return false;
  }
  // A box, a note or a stamp is touched anywhere over its box.
  const [bx, by, bw, bh] = markBox(mark);
  return x >= bx - radius && x <= bx + bw + radius && y >= by - radius && y <= by + bh + radius;
}

/** Where the segment `a`→`b` runs within `reach` of `(x, y)`, as the span of
 * its parameter in [0, 1] — `null` when it stays outside or only grazes it. */
function spanWithin(a: [number, number, number], b: [number, number, number], x: number, y: number, reach: number): [number, number] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const fx = a[0] - x;
  const fy = a[1] - y;
  const qa = dx * dx + dy * dy;
  const qc = fx * fx + fy * fy - reach * reach;
  if (qa === 0) return qc < 0 ? [0, 1] : null;
  const qb = 2 * (fx * dx + fy * dy);
  const disc = qb * qb - 4 * qa * qc;
  if (disc <= 0) return null;
  const root = Math.sqrt(disc);
  const t0 = (-qb - root) / (2 * qa);
  const t1 = (-qb + root) / (2 * qa);
  if (t1 <= 0 || t0 >= 1) return null;
  return [Math.max(0, t0), Math.min(1, t1)];
}

function sampleAt(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [round(a[0] + (b[0] - a[0]) * t), round(a[1] + (b[1] - a[1]) * t), Math.round((a[2] + (b[2] - a[2]) * t) * 100) / 100];
}

/** Where the segment `a`→`b` runs inside `rect` (`[x0, y0, x1, y1]`), as the
 * span of its parameter in [0, 1] — Liang–Barsky; `null` when it stays
 * outside or only touches an edge. */
function spanInRect(a: [number, number, number], b: [number, number, number], rect: [number, number, number, number]): [number, number] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [[-dx, a[0] - rect[0]], [dx, rect[2] - a[0]], [-dy, a[1] - rect[1]], [dy, rect[3] - a[1]]]) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 >= t1) return null;
  }
  return [t0, t1];
}

function inRect(p: [number, number, number], rect: [number, number, number, number]): boolean {
  return p[0] >= rect[0] && p[0] <= rect[2] && p[1] >= rect[1] && p[1] <= rect[3];
}

/** A stroke cut wherever `span` says a segment runs under the eraser: the
 * runs left outside it, each cut end on the eraser's edge. `null` when the
 * eraser misses it; `[]` when it took all of it. An arrow keeps its head only
 * on the run that still ends where the arrow did; the others are plain lines
 * (an arrow's samples are even, so they look the same). */
function cutWith(
  mark: InkMark,
  outside: (p: [number, number, number]) => boolean,
  span: (a: [number, number, number], b: [number, number, number]) => [number, number] | null,
): InkMark[] | null {
  const points = mark.points;
  if (points.length === 1) return outside(points[0]) ? null : [];
  const runs: [number, number, number][][] = [];
  let run: [number, number, number][] | null = outside(points[0]) ? [points[0]] : null;
  let cut = run === null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const within = span(a, b);
    if (!within) {
      (run ??= [a]).push(b);
      continue;
    }
    cut = true;
    if (run) {
      if (within[0] > 0) run.push(sampleAt(a, b, within[0]));
      runs.push(run);
      run = null;
    }
    if (within[1] < 1) run = [sampleAt(a, b, within[1]), b];
  }
  if (run) runs.push(run);
  if (!cut) return null;
  const tip = points[points.length - 1];
  // A run the cut left a single point long is no ink to keep. A comment stays
  // with the first run only, so the prompt does not repeat it per piece.
  const { comment: _comment, ...uncommented } = mark;
  return runs
    .filter((kept) => kept.some((p) => p[0] !== kept[0][0] || p[1] !== kept[0][1]))
    .map((kept, i) => {
      const base: InkMark = i === 0 ? mark : uncommented;
      if (mark.style !== "arrow" || kept[kept.length - 1] === tip) return { ...base, points: kept };
      const { style: _arrow, ...line } = base;
      return { ...line, points: kept };
    });
}

/** The eraser rubbed across a pen stroke: the runs of it left outside its
 * reach, each cut end on the reach's edge so the ink stops where the eraser
 * began. `null` when the eraser misses it; `[]` when it took all of it. */
export function cutStroke(mark: InkMark, x: number, y: number, radius: number): InkMark[] | null {
  const reach = radius + inkWidth(mark.width, 1) / 2;
  return cutWith(mark, (p) => Math.hypot(p[0] - x, p[1] - y) > reach, (a, b) => spanWithin(a, b, x, y, reach));
}

/** The area eraser over a pen stroke: the runs of it outside `rect`
 * (`[x0, y0, x1, y1]`), grown by half the stroke's width so no edge of ink
 * stays standing inside. */
export function cutStrokeByRect(mark: InkMark, rect: [number, number, number, number]): InkMark[] | null {
  const half = inkWidth(mark.width, 1) / 2;
  const grown: [number, number, number, number] = [rect[0] - half, rect[1] - half, rect[2] + half, rect[3] + half];
  return cutWith(mark, (p) => !inRect(p, grown), (a, b) => spanInRect(a, b, grown));
}

/** One page's marks after the eraser at `(x, y)`: pen strokes lose the part
 * under it (with `whole`, the whole stroke), boxes, notes and stamps go whole.
 * `null` when it touched none. */
function eraseMarks(marks: Mark[], x: number, y: number, radius: number, whole: boolean): Mark[] | null {
  let changed = false;
  const kept: Mark[] = [];
  for (const mark of marks) {
    if (mark.kind === "ink" && !whole) {
      const runs = cutStroke(mark, x, y, radius);
      if (runs) { kept.push(...runs); changed = true; } else kept.push(mark);
    } else if (touches(mark, x, y, radius)) changed = true;
    else kept.push(mark);
  }
  return changed ? kept : null;
}

/** The sent side's looser bound (`store.ts`): its marks never go out again
 * and are never trimmed, so it only keeps the record finite. */
export const SENT_LIMITS = { marks: LIMITS.marks * 4, points: LIMITS.points * 4 } as const;

function within(pages: Record<number, PageLayer>, limits: { marks: number; points: number }): boolean {
  const { marks, points } = markCount({ pages });
  return marks <= limits.marks && points <= limits.points;
}

/** The eraser at `(x, y)` on page `n`: it takes the part of every pen stroke
 * it rubs over — a stroke cut in the middle becomes two — and every box,
 * note and stamp it touches whole. A cut that would pass the ceilings takes the whole
 * stroke instead. With `sent`, the sent marks shown there too: they stay
 * until the reader has checked the agent's changes and erases them by hand,
 * never automatically. */
export function eraseAt(layer: Layer, n: number, x: number, y: number, radius: number, sent = false): Layer {
  const page = layer.pages[n];
  let next = layer;
  const cut = page && eraseMarks(page.marks, x, y, radius, false);
  if (page && cut) {
    next = withPage(layer, n, { ...page, marks: cut });
    if (!within(next.pages, LIMITS)) next = withPage(layer, n, { ...page, marks: eraseMarks(page.marks, x, y, radius, true) ?? page.marks });
  }
  return sent ? eraseSent(next, n, (marks, whole) => eraseMarks(marks, x, y, radius, whole)) : next;
}

/** The eraser dragged from `from` to `to`: applied at steps of half its
 * radius, so a quick swipe leaves no ink standing between two samples. */
export function eraseAlong(layer: Layer, n: number, from: [number, number], to: [number, number], radius: number, sent = false): Layer {
  const steps = Math.min(500, Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / Math.max(0.5, radius / 2))));
  let next = layer;
  for (let i = 1; i <= steps; i++) {
    next = eraseAt(next, n, from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, radius, sent);
  }
  return next;
}

/** The area eraser: everything inside the rectangle from `from` to `to` on
 * page `n` goes — the part of each pen stroke within it, and every box,
 * note and stamp it overlaps, whole. A cut that would pass the ceilings takes the whole
 * stroke instead. With `sent`, the shown sent marks too, as `eraseAt`. */
export function eraseRect(layer: Layer, n: number, from: [number, number], to: [number, number], sent = false): Layer {
  const rect: [number, number, number, number] = [Math.min(from[0], to[0]), Math.min(from[1], to[1]), Math.max(from[0], to[0]), Math.max(from[1], to[1])];
  const overlaps = (box: [number, number, number, number]) =>
    box[0] <= rect[2] && box[0] + box[2] >= rect[0] && box[1] <= rect[3] && box[1] + box[3] >= rect[1];
  const erase = (marks: Mark[], whole: boolean): Mark[] | null => {
    let changed = false;
    const kept: Mark[] = [];
    for (const mark of marks) {
      if (mark.kind === "ink") {
        const runs = cutStrokeByRect(mark, rect);
        if (!runs) kept.push(mark);
        else {
          changed = true;
          if (!whole) kept.push(...runs);
        }
      } else if (overlaps(markBox(mark))) changed = true;
      else kept.push(mark);
    }
    return changed ? kept : null;
  };
  const page = layer.pages[n];
  let next = layer;
  const cut = page && erase(page.marks, false);
  if (page && cut) {
    next = withPage(layer, n, { ...page, marks: cut });
    if (!within(next.pages, LIMITS)) next = withPage(layer, n, { ...page, marks: erase(page.marks, true) ?? page.marks });
  }
  return sent ? eraseSent(next, n, erase) : next;
}

/** Whether a pointer is a pen's eraser end — Windows Ink and Wacom report it
 * as the pen with button 5, or bit 32 of `buttons` — which erases whatever
 * tool is picked. */
export function stylusErases(event: { pointerType: string; button: number; buttons: number }): boolean {
  return event.pointerType === "pen" && (event.button === 5 || (event.buttons & 32) !== 0);
}

/** Clears page `n`'s unsent marks — with `sent`, its sent ones too. */
export function clearPage(layer: Layer, n: number, sent = false): Layer {
  const next = layer.pages[n] ? withPage(layer, n, { ...layer.pages[n], marks: [] }) : layer;
  return sent ? eraseSent(next, n, (marks) => (marks.length ? [] : null)) : next;
}

/** Clears every page's unsent marks — with `sent`, the sent ones too, as
 * Clear page does for one page (**Clear all marks**). The layer itself when
 * there is nothing to clear, so the history takes no empty step. */
export function clearAll(layer: Layer, sent = false): Layer {
  const pending = Object.keys(layer.pages).length > 0;
  const dropSent = sent && layer.sent !== undefined && Object.keys(layer.sent.pages).length > 0;
  if (!pending && !dropSent) return layer;
  // No sent mark is left for a logged round to name: the log goes too.
  return dropSent ? { ...layer, pages: {}, sent: { pages: {}, rounds: layer.sent!.rounds } } : { ...layer, pages: {} };
}

/** Where one mark starts: its 1-based page and the top of its bounding box,
 * in that page's own units (`PageLayer.size`). */
export type MarkAnchor = { page: number; y: number };

/** The top of a mark's bounding box. */
function markTop(mark: Mark): number {
  if (mark.kind === "ink") return mark.points.reduce((top, [, y]) => Math.min(top, y), Infinity);
  if (mark.kind === "box") return Math.min(mark.rect[1], mark.rect[1] + mark.rect[3]);
  if (mark.kind === "stamp") return mark.at[1] - mark.size / 2;
  return mark.at[1];
}

/** Every mark on show, in reading order — page by page, top to bottom — as
 * the stops Previous / Next mark step through: the unsent marks always, the
 * sent ones with `sent` (as the view shows them). */
export function markAnchors(layer: Layer, sent = false): MarkAnchor[] {
  const anchors: MarkAnchor[] = [];
  const collect = (pages: Record<number, PageLayer>) => {
    for (const [n, page] of Object.entries(pages)) {
      for (const mark of page.marks) {
        const y = markTop(mark);
        if (Number.isFinite(y)) anchors.push({ page: Number(n), y });
      }
    }
  };
  collect(layer.pages);
  if (sent && layer.sent) collect(layer.sent.pages);
  return anchors.sort((a, b) => a.page - b.page || a.y - b.y);
}

/** Page `n`'s sent marks through `erase` — tried as cuts first, then whole
 * when the cuts would pass `SENT_LIMITS`. */
function eraseSent(layer: Layer, n: number, erase: (marks: Mark[], whole: boolean) => Mark[] | null): Layer {
  const page = layer.sent?.pages[n];
  if (!layer.sent || !page) return layer;
  const place = (marks: Mark[]) => {
    const pages = { ...layer.sent!.pages };
    if (marks.length) pages[n] = { ...page, marks };
    else delete pages[n];
    return pages;
  };
  const cut = erase(page.marks, false);
  if (!cut) return layer;
  let pages = place(cut);
  if (!within(pages, SENT_LIMITS)) pages = place(erase(page.marks, true) ?? page.marks);
  return { ...layer, sent: { ...layer.sent, pages } };
}

export function isEmpty(layer: Layer): boolean {
  return Object.values(layer.pages).every((page) => page.marks.length === 0);
}

/** The marked pages' numbers, in order. */
export function markedPages(layer: Layer): number[] {
  return Object.entries(layer.pages)
    .filter(([, page]) => page.marks.length > 0)
    .map(([n]) => Number(n))
    .sort((a, b) => a - b);
}

/** Whether earlier rounds left sent marks to show. */
export function hasSent(layer: Layer): boolean {
  return Object.values(layer.sent?.pages ?? {}).some((page) => page.marks.length > 0);
}

function sameSize(a: [number, number], b: [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** How many Submits' marks the log keeps for the agent's ticks: an older
 * round's ticks find nothing and show no badge (the marks stay). */
export const MAX_LOGGED_ROUNDS = 6;

/** A Submit went out: the unsent marks of `only` (every marked page when
 * left out) join the sent ones and leave `pages`; marks on other pages stay
 * unsent. Sent marks are never dropped here — the reader checks the agent's
 * changes against them and erases them by hand. A page whose size changed
 * since its earlier round (a rebuilt PDF) carries its older marks over,
 * scaled to the new size — and the log's marks of that page with them, the
 * same objects where the sent side still holds them, so a tick still finds
 * its mark. With `roundId` the round is logged: each moved page's `marks`
 * as they are here, which must be the order the Submit sent them in — and,
 * with `words`, the page's words under each of them at Submit, by the same
 * index (`SentRound.words`), for the moved pages. */
export function markSent(layer: Layer, only?: readonly number[], roundId?: string, words?: Record<number, (string | null)[]>): Layer {
  const moving = (only ?? markedPages(layer)).filter((n) => (layer.pages[n]?.marks.length ?? 0) > 0);
  if (!moving.length) return layer;
  const rest = { ...layer.pages };
  const merged = { ...(layer.sent?.pages ?? {}) };
  let log = layer.sent?.log ?? [];
  for (const n of moving) {
    const now = layer.pages[n];
    delete rest[n];
    const before = merged[n];
    if (!before) {
      merged[n] = now;
      continue;
    }
    const scaled = scaleMarks(before, now.size);
    if (scaled !== before.marks) log = rescaleLog(log, n, before, scaled, now.size);
    merged[n] = { size: now.size, marks: [...scaled, ...now.marks] };
  }
  if (roundId) {
    const pages: Record<number, Mark[]> = {};
    for (const n of moving) pages[n] = layer.pages[n].marks;
    const entry: SentRound = { id: roundId, pages };
    const read: Record<number, (string | null)[]> = {};
    for (const n of moving) {
      const said = words?.[n];
      if (Array.isArray(said)) read[n] = said.slice(0, layer.pages[n].marks.length).map((w) => (typeof w === "string" ? w : null));
    }
    if (Object.keys(read).length) entry.words = read;
    log = trimLog([...log.filter((logged) => logged.id !== roundId), entry]);
  }
  const sent: SentLayer = { pages: merged, rounds: (layer.sent?.rounds ?? 0) + 1 };
  if (log.length) sent.log = log;
  return { pages: rest, sent };
}

/** A mark in another page size's units. */
function scaleMark(mark: Mark, sx: number, sy: number): Mark {
  const s = Math.min(sx, sy);
  if (mark.kind === "ink") return { ...mark, width: round(mark.width * s), points: mark.points.map(([x, y, p]) => [round(x * sx), round(y * sy), p]) };
  if (mark.kind === "box") return { ...mark, rect: [round(mark.rect[0] * sx), round(mark.rect[1] * sy), round(mark.rect[2] * sx), round(mark.rect[3] * sy)] };
  return { ...mark, at: [round(mark.at[0] * sx), round(mark.at[1] * sy)], size: round(mark.size * s) };
}

/** A page's marks in another page size's units. */
function scaleMarks(page: PageLayer, size: [number, number]): Mark[] {
  if (sameSize(page.size, size)) return page.marks;
  const sx = size[0] / page.size[0];
  const sy = size[1] / page.size[1];
  return page.marks.map((mark) => scaleMark(mark, sx, sy));
}

/** Page `n` of every logged round in the new size's units: a mark the sent
 * side still holds becomes its scaled object; one already erased or approved
 * is scaled alike (it matches nothing either way). */
function rescaleLog(log: SentRound[], n: number, before: PageLayer, scaled: Mark[], size: [number, number]): SentRound[] {
  const sx = size[0] / before.size[0];
  const sy = size[1] / before.size[1];
  const to = new Map<Mark, Mark>(before.marks.map((mark, i) => [mark, scaled[i]]));
  return log.map((entry) => {
    const marks = entry.pages[n];
    if (!marks) return entry;
    return { ...entry, pages: { ...entry.pages, [n]: marks.map((mark) => to.get(mark) ?? scaleMark(mark, sx, sy)) } };
  });
}

/** The newest `MAX_LOGGED_ROUNDS` rounds, and fewer while their marks
 * together pass `SENT_LIMITS` — so the log never outgrows the sent side's
 * own bound, even where it holds marks the sent side has lost. */
function trimLog(log: SentRound[]): SentRound[] {
  let kept = log.slice(-MAX_LOGGED_ROUNDS);
  const size = (entries: SentRound[]) => {
    let marks = 0;
    let points = 0;
    for (const entry of entries) {
      for (const page of Object.values(entry.pages)) {
        marks += page.length;
        for (const mark of page) if (mark.kind === "ink") points += mark.points.length;
      }
    }
    return marks <= SENT_LIMITS.marks && points <= SENT_LIMITS.points;
  };
  while (kept.length > 1 && !size(kept)) kept = kept.slice(1);
  return kept;
}

/** A logged round forgotten — its Submit's changes were undone, so the
 * agent's ticks for it mean nothing any more. The marks stay. */
export function forgetRound(layer: Layer, roundId: string): Layer {
  const log = layer.sent?.log;
  if (!log?.some((entry) => entry.id === roundId)) return layer;
  const kept = log.filter((entry) => entry.id !== roundId);
  const sent: SentLayer = { pages: layer.sent!.pages, rounds: layer.sent!.rounds };
  if (kept.length) sent.log = kept;
  return { ...layer, sent };
}

/** A round id for a Submit: 8 random `[a-z0-9]`, which the backend's
 * `markup::valid_round` takes (1–16 of them). */
export function mintRound(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  while (id.length < 8) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // 252 = 7 × 36: the bytes past it would favour the first letters.
    for (const byte of bytes) if (byte < 252 && id.length < 8) id += alphabet[byte % 36];
  }
  return id;
}

/** The agent's tick of one mark (`markup_done`): the Submit's round id, the
 * page and the 1-based place of the mark in that page's submitted marks. */
export type MarkTick = { round: string; page: number; mark: number };
/** A ticked mark as it stands on the sent side: `layer.sent.pages[page].marks[index]`. */
export type TickedMark = { page: number; index: number; round: string };

function sameMark(a: Mark, b: Mark): boolean {
  if (a.kind !== b.kind || a.color !== b.color) return false;
  if (a.kind !== "text" && b.kind !== "text" && (a.comment ?? "") !== (b.comment ?? "")) return false;
  if (a.kind === "stamp") {
    const other = b as StampMark;
    return a.symbol === other.symbol && a.size === other.size && a.at[0] === other.at[0] && a.at[1] === other.at[1];
  }
  if (a.kind === "ink") {
    const other = b as InkMark;
    return a.width === other.width && (a.style ?? "pen") === (other.style ?? "pen") && a.points.length === other.points.length
      && a.points.every((p, i) => p[0] === other.points[i][0] && p[1] === other.points[i][1] && p[2] === other.points[i][2]);
  }
  if (a.kind === "box") return a.rect.every((v, i) => v === (b as BoxMark).rect[i]);
  const other = b as TextMark;
  return a.size === other.size && a.text === other.text && a.at[0] === other.at[0] && a.at[1] === other.at[1];
}

/** The sent marks the agent ticked off: each tick's logged mark found on the
 * sent side — the same object, or, where none of that round's marks on the
 * page is (a record rebuilt from a copy), an equal one not yet claimed and
 * not any logged round's own object.
 * Ticks naming a round no longer logged, a mark past the round's page, or a
 * mark erased, cut or approved since find nothing and are dropped. Only
 * sent marks are ever matched, each once; in page and mark order. */
export function tickedMarks(layer: Layer, ticks: readonly MarkTick[]): TickedMark[] {
  const sent = layer.sent;
  if (!sent?.log?.length || !ticks.length) return [];
  const rounds = new Map(sent.log.map((entry) => [entry.id, entry]));
  const where = new Map<number, Map<Mark, number>>();
  const indexOf = (page: number) => {
    let found = where.get(page);
    if (!found) {
      found = new Map((sent.pages[page]?.marks ?? []).map((mark, i) => [mark, i]));
      where.set(page, found);
    }
    return found;
  };
  const shared = new Map<string, boolean>();
  // A sent mark some logged round holds by reference is that round's: never
  // another round's equal twin (after its own twin was approved or erased).
  let claimed: Set<Mark> | null = null;
  const loggedObjects = () => (claimed ??= new Set(sent.log!.flatMap((entry) => Object.values(entry.pages).flat())));
  const taken = new Set<string>();
  const out: TickedMark[] = [];
  for (const tick of ticks) {
    const logged = rounds.get(tick.round)?.pages[tick.page];
    const mark = logged?.[tick.mark - 1];
    const marks = sent.pages[tick.page]?.marks;
    if (!logged || !mark || !marks) continue;
    const byRef = indexOf(tick.page);
    let index = byRef.get(mark) ?? -1;
    if (index < 0) {
      // Equality only for a round whose marks are no longer the sent side's
      // objects at all: where any still is, a miss means this one is gone —
      // an approved mark's twin must not take its badge.
      const key = `${tick.round}\n${tick.page}`;
      let linked = shared.get(key);
      if (linked === undefined) {
        linked = logged.some((entry) => byRef.has(entry));
        shared.set(key, linked);
      }
      if (!linked) {
        const own = loggedObjects();
        index = marks.findIndex((entry, i) => !taken.has(`${tick.page}:${i}`) && !own.has(entry) && sameMark(entry, mark));
      }
    }
    if (index < 0 || taken.has(`${tick.page}:${index}`)) continue;
    taken.add(`${tick.page}:${index}`);
    out.push({ page: tick.page, index, round: tick.round });
  }
  return out.sort((a, b) => a.page - b.page || a.index - b.index);
}

/** The reader approved ticked marks: those sent marks go, nothing else
 * changes. Indices are `layer.sent.pages[page].marks` positions. */
export function approveMarks(layer: Layer, marks: readonly { page: number; index: number }[]): Layer {
  const sent = layer.sent;
  if (!sent || !marks.length) return layer;
  const drop = new Map<number, Set<number>>();
  for (const { page, index } of marks) {
    if (!sent.pages[page] || index < 0 || index >= sent.pages[page].marks.length) continue;
    if (!drop.has(page)) drop.set(page, new Set());
    drop.get(page)!.add(index);
  }
  if (!drop.size) return layer;
  const pages = { ...sent.pages };
  for (const [page, indices] of drop) {
    const kept = pages[page].marks.filter((_, i) => !indices.has(i));
    if (kept.length) pages[page] = { ...pages[page], marks: kept };
    else delete pages[page];
  }
  return { ...layer, sent: { ...sent, pages } };
}

/** One ticked mark approved (`approveMarks`). */
export function approveMark(layer: Layer, page: number, index: number): Layer {
  return approveMarks(layer, [{ page, index }]);
}

/** How close two ticked marks may sit and still be one remark, as a share of
 * their page's longer side (about 8 pt on A4): the strokes of one handwritten
 * word or a line through and the word written over it join; marks a line of
 * text apart mostly do not. Scaled to the page, so a picture's pixels group
 * alike. The prompt joins a run of strokes with the same gap (`markup.rs`
 * `RUN_GAP`). */
export const TICK_GROUP_GAP = 0.01;

/** Ticked marks of one page that sit together — one remark, often written in
 * many strokes — badged and approved as one (`tickGroups`). `box` is their
 * marks' boxes together, `marks` in page order. */
export type TickGroup = { page: number; marks: TickedMark[]; box: [number, number, number, number] };

/** Which of one page's marks sit together: any two whose boxes come within
 * `TICK_GROUP_GAP` of each other are in one group, and so is what either is
 * near. Each group as positions into `boxes`, ascending, with the boxes
 * together; groups by their first position. */
function nearGroups(size: [number, number], boxes: readonly [number, number, number, number][]): { at: number[]; box: [number, number, number, number] }[] {
  const gap = TICK_GROUP_GAP * Math.max(size[0], size[1]);
  const parent = boxes.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const near = (a: [number, number, number, number], b: [number, number, number, number]) =>
    Math.max(a[0], b[0]) - Math.min(a[0] + a[2], b[0] + b[2]) <= gap
    && Math.max(a[1], b[1]) - Math.min(a[1] + a[3], b[1] + b[3]) <= gap;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (near(boxes[i], boxes[j])) parent[root(j)] = root(i);
    }
  }
  const groups = new Map<number, { at: number[]; box: [number, number, number, number] }>();
  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const r = root(i);
    const group = groups.get(r);
    if (!group) {
      groups.set(r, { at: [i], box: [...box] });
      continue;
    }
    group.at.push(i);
    const [x, y, w, h] = group.box;
    const x0 = Math.min(x, box[0]);
    const y0 = Math.min(y, box[1]);
    group.box = [x0, y0, Math.max(x + w, box[0] + box[2]) - x0, Math.max(y + h, box[1] + box[3]) - y0];
  }
  return [...groups.values()];
}

/** The ticked marks grouped by page and nearness (`nearGroups`). Groups in
 * page order, then by their first mark. */
export function tickGroups(layer: Layer, ticked: readonly TickedMark[]): TickGroup[] {
  const byPage = new Map<number, TickedMark[]>();
  for (const entry of ticked) {
    if (!layer.sent?.pages[entry.page]?.marks[entry.index]) continue;
    const list = byPage.get(entry.page) ?? [];
    list.push(entry);
    byPage.set(entry.page, list);
  }
  const out: TickGroup[] = [];
  for (const [page, entries] of byPage) {
    const sent = layer.sent!.pages[page];
    const boxes = entries.map((entry) => markBox(sent.marks[entry.index]));
    for (const { at, box } of nearGroups(sent.size, boxes)) {
      out.push({ page, marks: at.map((i) => entries[i]).sort((a, b) => a.index - b.index), box });
    }
  }
  return out.sort((a, b) => a.page - b.page || a.marks[0].index - b.marks[0].index);
}

/** Unsent marks of one page that sit together — one remark as it is being
 * written — which a Submit of its own can send alone (`onlyMarks`,
 * `markSentSome`). `marks` are the layer's objects in page order. */
export type MarkGroup = { page: number; marks: Mark[]; box: [number, number, number, number] };

/** The unsent marks grouped by page and nearness (`nearGroups`), on `pages`
 * (every marked page when left out). Groups in page order, then by their
 * first mark. */
export function markGroups(layer: Layer, pages?: readonly number[]): MarkGroup[] {
  const out: MarkGroup[] = [];
  for (const page of pages ?? markedPages(layer)) {
    const now = layer.pages[page];
    if (!now?.marks.length) continue;
    for (const { at, box } of nearGroups(now.size, now.marks.map(markBox))) {
      out.push({ page, marks: at.map((i) => now.marks[i]), box });
    }
  }
  // Stable: within a page, groups stay in order of their first mark.
  return out.sort((a, b) => a.page - b.page);
}

/** What a group's Submit carries: the layer with only `shown` of page `page`
 * left unsent, in their page order — no other page, no other mark. */
export function onlyMarks(layer: Layer, page: number, shown: readonly Mark[]): Layer {
  const now = layer.pages[page];
  const want = new Set(shown);
  const marks = now ? now.marks.filter((mark) => want.has(mark)) : [];
  return { ...layer, pages: marks.length ? { [page]: { size: now!.size, marks } } : {} };
}

/** A group's Submit went out: of page `page`, only `shown` go to the sent
 * side (logged under `roundId` as `markSent` logs a page, with `words` the
 * words under each of `shown` in page order); the page's other marks and
 * every other page stay unsent. */
export function markSentSome(layer: Layer, page: number, shown: readonly Mark[], roundId?: string, words?: (string | null)[]): Layer {
  const now = layer.pages[page];
  if (!now) return layer;
  const want = new Set(shown);
  const moving = now.marks.filter((mark) => want.has(mark));
  if (!moving.length) return layer;
  const rest = now.marks.filter((mark) => !want.has(mark));
  const sent = markSent({ ...layer, pages: { ...layer.pages, [page]: { size: now.size, marks: moving } } }, [page], roundId, words ? { [page]: words } : undefined);
  return rest.length ? { ...sent, pages: { ...sent.pages, [page]: { size: now.size, marks: rest } } } : sent;
}

/** The reader approved a badge's group: of the sent marks it was drawn for
 * (`shown`, the objects), those still on page `page` and still ticked in
 * `layer` go — a mark erased, approved or unticked since stays as it is. */
export function approveShown(layer: Layer, ticks: readonly MarkTick[], page: number, shown: readonly Mark[]): Layer {
  const marks = layer.sent?.pages[page]?.marks;
  if (!marks) return layer;
  const want = new Set(shown);
  return approveMarks(layer, tickedMarks(layer, ticks).filter((entry) => entry.page === page && want.has(marks[entry.index])));
}

/** A mark's bounding box `[x, y, width, height]` in its page's units — a
 * stroke's with half its widest line around it. */
export function markBox(mark: Mark): [number, number, number, number] {
  if (mark.kind === "box") {
    const [x, y, w, h] = mark.rect;
    return [Math.min(x, x + w), Math.min(y, y + h), Math.abs(w), Math.abs(h)];
  }
  if (mark.kind === "text") return textBox(mark);
  if (mark.kind === "stamp") {
    const reach = mark.size * (1 + STAMP_WIDTH) / 2;
    return [mark.at[0] - reach, mark.at[1] - reach, 2 * reach, 2 * reach];
  }
  const half = inkWidth(mark.width, 1) / 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const head = mark.style === "arrow" ? arrowHead(mark.points, mark.width) ?? [] : [];
  for (const [x, y] of [...mark.points, ...head]) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return [x0 - half, y0 - half, x1 - x0 + 2 * half, y1 - y0 + 2 * half];
}

/** Where a group's own Submit button goes — its top-left corner in CSS px,
 * given the group's box, the page's scale, the page and the button in CSS
 * px, and every unsent mark's box on the page (page units): just outside the
 * group, never over its marks or any other's, so it hides nothing the reader
 * wrote. Tried in turn: above its right end (where writing does not go on),
 * above its left end, below either end, beside it on the right or left; the
 * first spot on the page clear of every mark wins, else the first on the
 * page, else the first clamped onto it. */
export function submitSpot(
  box: [number, number, number, number],
  scale: number,
  page: [number, number],
  button: [number, number],
  marks: readonly [number, number, number, number][],
): [number, number] {
  const GAP = 3;
  const [bw, bh] = button;
  const [x, y, w, h] = box.map((v) => v * scale);
  const spots: [number, number][] = [
    [x + w - bw, y - GAP - bh],
    [x, y - GAP - bh],
    [x + w - bw, y + h + GAP],
    [x, y + h + GAP],
    [x + w + GAP, y],
    [x - GAP - bw, y],
  ];
  const onPage = ([l, t]: [number, number]) => l >= 0 && t >= 0 && l + bw <= page[0] && t + bh <= page[1];
  const clear = ([l, t]: [number, number]) => marks.every(([mx, my, mw, mh]) =>
    l >= (mx + mw) * scale || l + bw <= mx * scale || t >= (my + mh) * scale || t + bh <= my * scale);
  const pick = spots.find((spot) => onPage(spot) && clear(spot)) ?? spots.find(onPage);
  if (pick) return pick;
  const clamp = (v: number, max: number) => Math.min(Math.max(0, max), Math.max(0, v));
  return [clamp(spots[0][0], page[0] - bw), clamp(spots[0][1], page[1] - bh)];
}

/** Where a tick's ✓ badge goes — its top-left corner in CSS px, given the
 * mark's `markBox`, the page's scale and its size in CSS px: just outside the
 * box, diagonally above its top-right corner (left of the box when the page
 * ends on the right, below it when the page ends above), so the badge never
 * covers the words the mark was on and the change stays readable. Always on
 * the page. */
export function tickBadgeSpot(
  box: [number, number, number, number],
  scale: number,
  page: [number, number],
  badge: number,
): [number, number] {
  const GAP = 2;
  const [x, y, w, h] = box;
  let left = (x + w) * scale + GAP;
  if (left + badge > page[0]) left = x * scale - GAP - badge;
  let top = y * scale - GAP - badge;
  if (top < 0) top = (y + h) * scale + GAP;
  const clamp = (v: number, max: number) => Math.min(Math.max(0, max - badge), Math.max(0, v));
  return [clamp(left, page[0]), clamp(top, page[1])];
}

/** The sent marks gone for good, and the round log with them; the unsent
 * ones stay. */
export function clearSent(layer: Layer): Layer {
  return layer.sent ? { pages: layer.pages } : layer;
}

/** How much wider the marker draws than the pen — about a line of text
 * (`pen.ts` sizes new strokes by it; a restyled stroke changes by it). */
export const MARKER_FACTOR = 5;

/** Whether a mark may wear `color`: yellow only where it highlights — a box
 * or the marker — as the pen bar offers it (`pen.ts` `colorsFor`). */
function wears(mark: Mark, color: MarkColor): boolean {
  return color !== "yellow" || mark.kind === "box" || (mark.kind === "ink" && mark.style === "marker");
}

/** The select tool's click: the topmost unsent mark of `page` within
 * `radius` of `(x, y)` — drawn last, so the one the reader sees on top — or
 * -1. `page` is `layer.pages[n]`, so sent marks are never picked. */
export function markAt(page: PageLayer | undefined, x: number, y: number, radius: number): number {
  const marks = page?.marks ?? [];
  for (let i = marks.length - 1; i >= 0; i--) if (touches(marks[i], x, y, radius)) return i;
  return -1;
}

/** The select tool's dragged rectangle (`[x0, y0, x1, y1]`, either way
 * round): every unsent mark it reaches, ascending — a stroke where its ink
 * runs into the rectangle, anything else where its box overlaps it. */
export function marksIn(page: PageLayer | undefined, rect: [number, number, number, number]): number[] {
  const r: [number, number, number, number] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  const out: number[] = [];
  (page?.marks ?? []).forEach((mark, i) => {
    if (mark.kind === "ink") {
      const p = mark.points;
      if (p.some((point) => inRect(point, r)) || p.some((point, j) => j > 0 && spanInRect(p[j - 1], point, r) !== null)) out.push(i);
      return;
    }
    const [x, y, w, h] = markBox(mark);
    if (x <= r[2] && x + w >= r[0] && y <= r[3] && y + h >= r[1]) out.push(i);
  });
  return out;
}

/** The valid, distinct positions of `indices` on `page`. */
function picked(page: PageLayer, indices: readonly number[]): Set<number> {
  return new Set(indices.filter((i) => Number.isInteger(i) && i >= 0 && i < page.marks.length));
}

/** A mark moved by `(dx, dy)` page units, rounded as stored. */
function shifted(mark: Mark, dx: number, dy: number): Mark {
  if (mark.kind === "ink") return { ...mark, points: mark.points.map(([x, y, p]): [number, number, number] => [round(x + dx), round(y + dy), p]) };
  if (mark.kind === "box") return { ...mark, rect: [round(mark.rect[0] + dx), round(mark.rect[1] + dy), mark.rect[2], mark.rect[3]] };
  return { ...mark, at: [round(mark.at[0] + dx), round(mark.at[1] + dy)] };
}

/** The selection dragged by `(dx, dy)`: the marks at `indices` on page `n`
 * move together, held back where one would leave the page — their boxes
 * together stay on it (a box already over an edge is not pushed back, only
 * kept from going further). The layer itself when nothing moves, so the
 * history takes no empty step. */
export function moveMarks(layer: Layer, n: number, indices: readonly number[], dx: number, dy: number): Layer {
  const page = layer.pages[n];
  if (!page) return layer;
  const chosen = picked(page, indices);
  if (!chosen.size) return layer;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of chosen) {
    const [x, y, w, h] = markBox(page.marks[i]);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  }
  const clamp = (d: number, low: number, high: number) => Math.min(Math.max(d, Math.min(0, low)), Math.max(0, high));
  const mx = round(clamp(dx, -x0, page.size[0] - x1));
  const my = round(clamp(dy, -y0, page.size[1] - y1));
  if (!mx && !my) return layer;
  return withPage(layer, n, { ...page, marks: page.marks.map((mark, i) => (chosen.has(i) ? shifted(mark, mx, my) : mark)) });
}

/** One mark with `change` applied: a style on a pen stroke only (its
 * samples' pressure kept; the plain pen drops the field, and the stroke
 * widens or narrows by `MARKER_FACTOR` into or out of the marker), then a
 * colour only where the mark may wear it (`wears`) — a stroke that leaves the
 * marker gives up its yellow for red. */
function restyled(mark: Mark, change: { color?: MarkColor; style?: PenStyle }): Mark {
  let next: Mark = mark;
  if (change.style && mark.kind === "ink" && (mark.style ?? "pen") !== change.style) {
    const was = mark.style ?? "pen";
    const factor = was === "marker" ? 1 / MARKER_FACTOR : change.style === "marker" ? MARKER_FACTOR : 1;
    const { style: _style, ...plain } = mark;
    const width = Math.round(Math.min(100, Math.max(0.1, mark.width * factor)) * 10) / 10;
    next = { ...plain, width, ...(change.style === "pen" ? {} : { style: change.style }) };
  }
  const wanted = change.color && wears(next, change.color) ? change.color : next.color;
  const color = wears(next, wanted) ? wanted : "red";
  return color === next.color ? next : { ...next, color };
}

/** The selection recoloured or restyled (`restyled`). The layer itself when
 * no mark changes. */
export function restyleMarks(layer: Layer, n: number, indices: readonly number[], change: { color?: MarkColor; style?: PenStyle }): Layer {
  const page = layer.pages[n];
  if (!page) return layer;
  const chosen = picked(page, indices);
  let changed = false;
  const marks = page.marks.map((mark, i) => {
    if (!chosen.has(i)) return mark;
    const next = restyled(mark, change);
    if (next !== mark) changed = true;
    return next;
  });
  return changed ? withPage(layer, n, { ...page, marks }) : layer;
}

/** The selection deleted. */
export function removeMarks(layer: Layer, n: number, indices: readonly number[]): Layer {
  const page = layer.pages[n];
  if (!page) return layer;
  const chosen = picked(page, indices);
  if (!chosen.size) return layer;
  return withPage(layer, n, { ...page, marks: page.marks.filter((_, i) => !chosen.has(i)) });
}

/** A comment as stored: one plain line — control characters (line breaks
 * among them) become spaces, the ends trimmed — cut to `MAX_COMMENT`
 * characters. The desktop refuses anything else (`markup::validate_body`). */
export function cleanComment(comment: string): string {
  return [...comment.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim()].slice(0, MAX_COMMENT).join("").trim();
}

/** The reader's comment on the mark at `index` of page `n` (`cleanComment`);
 * `null` or nothing left after cleaning removes it. A typed note takes none —
 * it says what it wants itself — and is left as it is. */
export function setComment(layer: Layer, n: number, index: number, comment: string | null): Layer {
  const page = layer.pages[n];
  const mark = page?.marks[index];
  if (!page || !mark || mark.kind === "text") return layer;
  const text = comment === null ? "" : cleanComment(comment);
  if (text === (mark.comment ?? "")) return layer;
  const { comment: _old, ...bare } = mark;
  return replaceMark(layer, n, index, text ? { ...bare, comment: text } : bare);
}

/** How many samples a snapped ellipse is drawn with. */
const ELLIPSE_SAMPLES = 48;

/** A held stroke straightened into the shape it almost is (`SNAP_HOLD_MS`
 * in `pen.ts`): an almost-straight one becomes the line from its first to its
 * last sample, an almost-closed round one the ellipse its samples span; an
 * arrow always becomes straight. `null` when it is neither — handwriting, a
 * tick, a scribble — or too small to tell. A pen stroke keeps its mean
 * pressure, evenly; the other styles draw evenly anyway. */
export function snapStroke(mark: InkMark): InkMark | null {
  const points = mark.points;
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const pressure = (mark.style ?? "pen") === "pen"
    ? Math.round((points.reduce((sum, p) => sum + p[2], 0) / points.length) * 100) / 100
    : 0.5;
  const chord = Math.hypot(last[0] - first[0], last[1] - first[1]);
  const line = (): InkMark => ({ ...mark, points: [[round(first[0]), round(first[1]), pressure], [round(last[0]), round(last[1]), pressure]] });
  if (mark.style === "arrow") return chord > 0 ? line() : null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, length = 0;
  points.forEach((p, i) => {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
    if (i > 0) length += Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]);
  });
  const span = Math.max(x1 - x0, y1 - y0);
  // Below a few widths of its own line a stroke is a dot or a dash, no shape.
  const smallest = Math.max(4, 3 * mark.width);
  if (span < smallest) return null;
  if (chord <= 0.2 * span) {
    // Closed: round enough when its samples sit near the ellipse they span.
    const rx = (x1 - x0) / 2;
    const ry = (y1 - y0) / 2;
    if (points.length < 6 || length < 2.2 * span || Math.min(rx, ry) * 2 < smallest / 2) return null;
    const cx = x0 + rx;
    const cy = y0 + ry;
    const off = points.reduce((sum, p) => sum + Math.abs(Math.hypot((p[0] - cx) / rx, (p[1] - cy) / ry) - 1), 0) / points.length;
    if (off > 0.2) return null;
    const start = Math.atan2((first[1] - cy) / ry, (first[0] - cx) / rx);
    const ring: [number, number, number][] = [];
    for (let i = 0; i <= ELLIPSE_SAMPLES; i++) {
      const angle = start + (2 * Math.PI * i) / ELLIPSE_SAMPLES;
      ring.push([round(cx + rx * Math.cos(angle)), round(cy + ry * Math.sin(angle)), pressure]);
    }
    return { ...mark, points: ring };
  }
  const worst = points.reduce((most, p) => Math.max(most, distanceToSegment([p[0], p[1]], [first[0], first[1]], [last[0], last[1]])), 0);
  return worst <= Math.max(1, 0.07 * chord) ? line() : null;
}

/** Undo and redo over whole layers: each change keeps the one before it. The
 * marks themselves are shared between snapshots, never copied. */
export type History = { past: Layer[]; present: Layer; future: Layer[] };
const MAX_UNDO = 200;

/** A fresh history over `layer` — with `past`, the undo steps a stored
 * record kept (`store.ts`, the last `MAX_STORED_UNDO`), oldest first. Redo is
 * never kept. */
export function startHistory(layer: Layer = EMPTY_LAYER, past?: readonly Layer[]): History {
  return { past: past ? past.slice(-MAX_UNDO) : [], present: layer, future: [] };
}

export function commit(history: History, next: Layer): History {
  if (next === history.present) return history;
  return { past: [...history.past, history.present].slice(-MAX_UNDO), present: next, future: [] };
}

export function undo(history: History): History {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
}

export function redo(history: History): History {
  const [next, ...rest] = history.future;
  if (!next) return history;
  return { past: [...history.past, history.present], present: next, future: rest };
}

/** Whether a stored value is a layer this build can draw — storage is the
 * phone's own, but it outlives builds and can be anything after a bad write. */
export function isLayer(value: unknown): value is Layer {
  if (!value || typeof value !== "object") return false;
  if (!validPages((value as { pages?: unknown }).pages)) return false;
  // A record from before rounds has no `sent`; one that has it must be sound.
  const sent = (value as { sent?: unknown }).sent;
  if (sent === undefined) return true;
  if (!sent || typeof sent !== "object") return false;
  const { pages, rounds, log } = sent as { pages?: unknown; rounds?: unknown; log?: unknown };
  if (!(typeof rounds === "number" && Number.isInteger(rounds) && rounds >= 0 && validPages(pages))) return false;
  // A record from before ticks has no `log`.
  return log === undefined || validLog(log);
}

/** A round id as the backend takes it (`markup::valid_round`). */
const ROUND_ID = /^[a-z0-9]{1,16}$/;

function validLog(log: unknown): boolean {
  if (!Array.isArray(log)) return false;
  return log.every((entry: unknown) => {
    if (!entry || typeof entry !== "object") return false;
    const { id, pages, words } = entry as { id?: unknown; pages?: unknown; words?: unknown };
    if (typeof id !== "string" || !ROUND_ID.test(id) || !pages || typeof pages !== "object") return false;
    // A round logged before before/after captions has no `words`.
    if (words !== undefined && !validWords(words)) return false;
    return Object.entries(pages as Record<string, unknown>).every(([n, marks]) => /^[1-9]\d*$/.test(n) && Array.isArray(marks) && marks.every(validMark));
  });
}

function validWords(words: unknown): boolean {
  if (!words || typeof words !== "object" || Array.isArray(words)) return false;
  return Object.entries(words as Record<string, unknown>).every(([n, said]) =>
    /^[1-9]\d*$/.test(n) && Array.isArray(said) && said.every((w: unknown) => w === null || typeof w === "string"));
}

function validPages(pages: unknown): boolean {
  if (!pages || typeof pages !== "object") return false;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  return Object.entries(pages as Record<string, unknown>).every(([n, page]) => {
    if (!/^[1-9]\d*$/.test(n) || !page || typeof page !== "object") return false;
    const { size, marks } = page as { size?: unknown; marks?: unknown };
    if (!Array.isArray(size) || size.length !== 2 || !size.every(num) || !Array.isArray(marks)) return false;
    return marks.every(validMark);
  });
}

function validMark(mark: unknown): boolean {
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (!mark || typeof mark !== "object") return false;
  const m = mark as Record<string, unknown>;
  if (!MARK_COLORS.includes(m.color as MarkColor)) return false;
  // Marks from before comments have none; a note never takes one.
  if (m.comment !== undefined && (m.kind === "text" || typeof m.comment !== "string" || [...m.comment].length > MAX_COMMENT)) return false;
  if (m.kind === "stamp") return Array.isArray(m.at) && m.at.length === 2 && m.at.every(num) && num(m.size) && STAMP_SYMBOLS.includes(m.symbol as StampSymbol);
  if (m.kind === "ink") return num(m.width) && (m.style === undefined || PEN_STYLES.includes(m.style as PenStyle)) && Array.isArray(m.points) && m.points.length > 0
    && m.points.every((p: unknown) => Array.isArray(p) && p.length === 3 && p.every(num));
  if (m.kind === "box") return Array.isArray(m.rect) && m.rect.length === 4 && m.rect.every(num);
  if (m.kind === "text") return Array.isArray(m.at) && m.at.length === 2 && m.at.every(num) && num(m.size) && typeof m.text === "string";
  return false;
}
