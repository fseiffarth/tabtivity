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

/** A pen stroke: `[x, y, pressure]` samples and its base width. */
export type InkMark = { kind: "ink"; color: MarkColor; width: number; points: [number, number, number][] };
/** A highlighter box: `[x, y, width, height]`. */
export type BoxMark = { kind: "box"; color: MarkColor; rect: [number, number, number, number] };
/** A typed note, anchored at its top-left corner; `\n` breaks lines. */
export type TextMark = { kind: "text"; color: MarkColor; at: [number, number]; size: number; text: string };
export type Mark = InkMark | BoxMark | TextMark;

/** One page's marks and the size they are measured in. */
export type PageLayer = { size: [number, number]; marks: Mark[] };
/** The marks earlier Submits sent, drawn dimmed and never sent again
 * (`docs/pdf_markup_rounds_plan.md` §2.1), and how many rounds went out.
 * Only the reader removes them (eraser, Clear page, Clear all marks, Clear
 * sent marks). */
export type SentLayer = { pages: Record<number, PageLayer>; rounds: number };
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
  const [bx, by, bw, bh] = mark.kind === "box" ? mark.rect : textBox(mark);
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

/** The eraser rubbed across a pen stroke: the runs of it left outside its
 * reach, each cut end on the reach's edge so the ink stops where the eraser
 * began. `null` when the eraser misses it; `[]` when it took all of it. */
export function cutStroke(mark: InkMark, x: number, y: number, radius: number): InkMark[] | null {
  const reach = radius + inkWidth(mark.width, 1) / 2;
  const points = mark.points;
  if (points.length === 1) return Math.hypot(points[0][0] - x, points[0][1] - y) <= reach ? [] : null;
  const runs: [number, number, number][][] = [];
  let run: [number, number, number][] | null = Math.hypot(points[0][0] - x, points[0][1] - y) > reach ? [points[0]] : null;
  let cut = run === null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const span = spanWithin(a, b, x, y, reach);
    if (!span) {
      (run ??= [a]).push(b);
      continue;
    }
    cut = true;
    if (run) {
      if (span[0] > 0) run.push(sampleAt(a, b, span[0]));
      runs.push(run);
      run = null;
    }
    if (span[1] < 1) run = [sampleAt(a, b, span[1]), b];
  }
  if (run) runs.push(run);
  if (!cut) return null;
  // A run the cut left a single point long is no ink to keep.
  return runs
    .filter((kept) => kept.some((p) => p[0] !== kept[0][0] || p[1] !== kept[0][1]))
    .map((kept) => ({ ...mark, points: kept }));
}

/** One page's marks after the eraser at `(x, y)`: pen strokes lose the part
 * under it (with `whole`, the whole stroke), boxes and notes go whole.
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
 * it rubs over — a stroke cut in the middle becomes two — and every box and
 * note it touches whole. A cut that would pass the ceilings takes the whole
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
  return dropSent ? { ...layer, pages: {}, sent: { ...layer.sent!, pages: {} } } : { ...layer, pages: {} };
}

/** Where one mark starts: its 1-based page and the top of its bounding box,
 * in that page's own units (`PageLayer.size`). */
export type MarkAnchor = { page: number; y: number };

/** The top of a mark's bounding box. */
function markTop(mark: Mark): number {
  if (mark.kind === "ink") return mark.points.reduce((top, [, y]) => Math.min(top, y), Infinity);
  if (mark.kind === "box") return Math.min(mark.rect[1], mark.rect[1] + mark.rect[3]);
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

/** A Submit went out: the unsent marks of `only` (every marked page when
 * left out) join the sent ones and leave `pages`; marks on other pages stay
 * unsent. Sent marks are never dropped here — the reader checks the agent's
 * changes against them and erases them by hand. A page whose size changed
 * since its earlier round (a rebuilt PDF) carries its older marks over,
 * scaled to the new size. */
export function markSent(layer: Layer, only?: readonly number[]): Layer {
  const moving = (only ?? markedPages(layer)).filter((n) => (layer.pages[n]?.marks.length ?? 0) > 0);
  if (!moving.length) return layer;
  const rest = { ...layer.pages };
  const merged = { ...(layer.sent?.pages ?? {}) };
  for (const n of moving) {
    const now = layer.pages[n];
    delete rest[n];
    const before = merged[n];
    merged[n] = before ? { size: now.size, marks: [...scaleMarks(before, now.size), ...now.marks] } : now;
  }
  return { pages: rest, sent: { pages: merged, rounds: (layer.sent?.rounds ?? 0) + 1 } };
}

/** A page's marks in another page size's units. */
function scaleMarks(page: PageLayer, size: [number, number]): Mark[] {
  if (sameSize(page.size, size)) return page.marks;
  const sx = size[0] / page.size[0];
  const sy = size[1] / page.size[1];
  const s = Math.min(sx, sy);
  return page.marks.map((mark): Mark => {
    if (mark.kind === "ink") return { ...mark, width: round(mark.width * s), points: mark.points.map(([x, y, p]) => [round(x * sx), round(y * sy), p]) };
    if (mark.kind === "box") return { ...mark, rect: [round(mark.rect[0] * sx), round(mark.rect[1] * sy), round(mark.rect[2] * sx), round(mark.rect[3] * sy)] };
    return { ...mark, at: [round(mark.at[0] * sx), round(mark.at[1] * sy)], size: round(mark.size * s) };
  });
}

/** The sent marks gone for good; the unsent ones stay. */
export function clearSent(layer: Layer): Layer {
  return layer.sent ? { pages: layer.pages } : layer;
}

/** Undo and redo over whole layers: each change keeps the one before it. The
 * marks themselves are shared between snapshots, never copied. */
export type History = { past: Layer[]; present: Layer; future: Layer[] };
const MAX_UNDO = 200;

export function startHistory(layer: Layer = EMPTY_LAYER): History {
  return { past: [], present: layer, future: [] };
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
  const { pages, rounds } = sent as { pages?: unknown; rounds?: unknown };
  return typeof rounds === "number" && Number.isInteger(rounds) && rounds >= 0 && validPages(pages);
}

function validPages(pages: unknown): boolean {
  if (!pages || typeof pages !== "object") return false;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const color = (v: unknown) => MARK_COLORS.includes(v as MarkColor);
  return Object.entries(pages as Record<string, unknown>).every(([n, page]) => {
    if (!/^[1-9]\d*$/.test(n) || !page || typeof page !== "object") return false;
    const { size, marks } = page as { size?: unknown; marks?: unknown };
    if (!Array.isArray(size) || size.length !== 2 || !size.every(num) || !Array.isArray(marks)) return false;
    return marks.every((mark: unknown) => {
      if (!mark || typeof mark !== "object") return false;
      const m = mark as Record<string, unknown>;
      if (!color(m.color)) return false;
      if (m.kind === "ink") return num(m.width) && Array.isArray(m.points) && m.points.length > 0
        && m.points.every((p: unknown) => Array.isArray(p) && p.length === 3 && p.every(num));
      if (m.kind === "box") return Array.isArray(m.rect) && m.rect.length === 4 && m.rect.every(num);
      if (m.kind === "text") return Array.isArray(m.at) && m.at.length === 2 && m.at.every(num) && num(m.size) && typeof m.text === "string";
      return false;
    });
  });
}
