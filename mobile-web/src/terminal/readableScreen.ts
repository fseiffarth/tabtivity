/**
 * Turns xterm's emulated screen into a readable, phone-width rendering of the
 * *same* session — colours, emphasis and all.
 *
 * This deliberately replaces the earlier semantic parser, which classified each
 * line by regex into prompt/tool/success/warning/error cards. That parser was
 * guessing: it turned a numbered list inside an ordinary answer into an
 * "approval dialog" with buttons that injected keystrokes, split a tool call
 * from its own result, and threw away the colour the program had already sent.
 *
 * Here nothing is inferred. Style comes from the cells the program actually
 * wrote, and the only thing dropped is box-drawing decoration — announced
 * whenever earlier output is left out.
 */

import { translate, useI18nStore } from "../../../src/lib/i18n";

export interface ReadableSpan {
  text: string;
  /** Space-separated attribute classes (`b`, `i`, `u`, `d`, `s`). */
  className?: string;
  color?: string;
  background?: string;
}

export interface ReadableLine {
  /** Stable across frames: the absolute buffer row the logical line starts at. */
  key: string;
  text: string;
  spans: ReadableSpan[];
  /** Original labelled rule, for detecting the input frame after stripping it. */
  frameText?: string;
  /** A frame-only row was dropped right above this line. No paragraph break
   * stands in for it, so this is what still says the program drew a divider
   * here (`selectPrompt`'s heading stops at one). */
  afterRule?: boolean;
}

export interface ReadableScreen {
  lines: ReadableLine[];
  /** Whether output above the first rendered line exists but is not shown. */
  clipped: boolean;
}

export interface ReadableCellLike {
  getChars(): string;
  getWidth(): number;
  isBold(): number;
  isItalic(): number;
  isDim(): number;
  isUnderline(): number;
  isStrikethrough(): number;
  isInverse(): number;
  isInvisible(): number;
  isFgDefault(): boolean;
  isBgDefault(): boolean;
  isFgPalette(): boolean;
  isBgPalette(): boolean;
  isFgRGB(): boolean;
  isBgRGB(): boolean;
  getFgColor(): number;
  getBgColor(): number;
}

export interface ReadableLineLike {
  readonly isWrapped?: boolean;
  readonly length?: number;
  translateToString(trimRight?: boolean): string;
  getCell?(x: number, cell?: ReadableCellLike): ReadableCellLike | undefined;
}

export interface ReadableBufferLike {
  readonly length: number;
  getLine(row: number): ReadableLineLike | undefined;
}

/** Rows read off the end of the buffer. Bounds the per-frame cost on a phone. */
export const MAX_ROWS = 1_200;
/** Logical lines kept after joining and blank-collapsing. */
export const MAX_LINES = 400;
/** A single logical line longer than this is clipped, with a marker. */
const MAX_LINE = 4_000;

/** The default foreground/background of the phone terminal theme. Needed to
 * resolve `inverse` on a cell that is otherwise using terminal defaults. */
const DEFAULT_FG = "#e7e9f2";
const DEFAULT_BG = "#0b0d13";

/** The 16 ANSI colours, tuned for the dark reading background rather than for
 * a white terminal: the dim variants of blue and black stay legible. */
const BASE_16 = [
  "#3f4453", "#ed7180", "#55d187", "#f4c95d", "#7aa9f7", "#c39bf5", "#62d0d4", "#c8cdda",
  "#5b6273", "#ff97a2", "#7ce4a8", "#ffdd8a", "#9dc2ff", "#d9bbff", "#8fe6e8", "#f2f4fb",
];

const CUBE = [0, 95, 135, 175, 215, 255];

/** xterm's 256-colour palette: 16 base colours, a 6×6×6 cube, a 24-step ramp. */
function paletteColor(index: number) {
  if (index < 16) return BASE_16[index];
  if (index < 232) {
    const offset = index - 16;
    const r = CUBE[Math.floor(offset / 36) % 6];
    const g = CUBE[Math.floor(offset / 6) % 6];
    const b = CUBE[offset % 6];
    return `rgb(${r},${g},${b})`;
  }
  const level = 8 + (index - 232) * 10;
  return `rgb(${level},${level},${level})`;
}

function rgbColor(packed: number) {
  return `rgb(${(packed >> 16) & 0xff},${(packed >> 8) & 0xff},${packed & 0xff})`;
}

function cellColor(cell: ReadableCellLike, layer: "fg" | "bg") {
  const isDefault = layer === "fg" ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return undefined;
  const isPalette = layer === "fg" ? cell.isFgPalette() : cell.isBgPalette();
  const value = layer === "fg" ? cell.getFgColor() : cell.getBgColor();
  if (isPalette) return paletteColor(value);
  const isRGB = layer === "fg" ? cell.isFgRGB() : cell.isBgRGB();
  return isRGB ? rgbColor(value) : undefined;
}

function styleOf(cell: ReadableCellLike): Omit<ReadableSpan, "text"> {
  let color = cellColor(cell, "fg");
  let background = cellColor(cell, "bg");
  if (cell.isInverse()) {
    const fg = color ?? DEFAULT_FG;
    const bg = background ?? DEFAULT_BG;
    color = bg;
    background = fg;
  }
  const classes: string[] = [];
  if (cell.isBold()) classes.push("b");
  if (cell.isItalic()) classes.push("i");
  if (cell.isUnderline()) classes.push("u");
  if (cell.isDim()) classes.push("d");
  if (cell.isStrikethrough()) classes.push("s");
  return {
    className: classes.length ? classes.join(" ") : undefined,
    color,
    background,
  };
}

function sameStyle(a: Omit<ReadableSpan, "text">, b: Omit<ReadableSpan, "text">) {
  return a.className === b.className && a.color === b.color && a.background === b.background;
}

/** Everything an agent draws its frames with. A line made only of these is
 * decoration, and on a phone it reflows into nonsense. */
const BORDER_ONLY = /^[\s─-╿▀-▟―—]+$/u;
/** A leading/trailing frame edge around real content on the same row.
 *
 * The left edge is bounded to the first few columns on purpose. A bar deeper
 * than that is not this row's frame: it is one drawn beside or behind the
 * content — OpenCode's full TUI paints its centred dialogs over the composer
 * box, so each dialog row carries the box's `┃` at column 70 with the dialog's
 * own text 12 columns further right. Stripping `^\s*┃\s?` there took the whole
 * indent with it, which dropped those rows out of column with the rest of the
 * dialog (and glued the box's own bleed-through onto them). Left in place the
 * bar costs one glyph and every column downstream still lines up. */
const LEFT_EDGE = /^ {0,7}[│┃┆┇┊┋]\s?/u;
const RIGHT_EDGE = /\s*[│┃┆┇┊┋]\s*$/u;
/** Labelled horizontal rules (e.g. `─ Worked for 2m ─────`). Keeping their
 * desktop-width strokes makes one divider wrap into many bright phone rows.
 * Require strokes on both sides; ordinary dashes in prose/code stay intact. */
const LABELLED_RULE = /^\s*[╭┌┏╔]?[─━═]+\s+\S.*?\s+[─━═]+[╮┐┓╗]?\s*$/u;
const RULE_LEFT = /^\s*[╭┌┏╔]?[─━═]+\s+/u;
const RULE_RIGHT = /\s+[─━═]+[╮┐┓╗]?\s*$/u;

/** Drops `count` characters from the front of a span run, in place. */
function trimSpansLeft(spans: ReadableSpan[], count: number) {
  let remaining = count;
  while (remaining > 0 && spans.length > 0) {
    const span = spans[0];
    if (span.text.length <= remaining) {
      remaining -= span.text.length;
      spans.shift();
    } else {
      span.text = span.text.slice(remaining);
      remaining = 0;
    }
  }
}

/** Drops `count` characters from the end of a span run, in place. */
function trimSpansRight(spans: ReadableSpan[], count: number) {
  let remaining = count;
  while (remaining > 0 && spans.length > 0) {
    const span = spans[spans.length - 1];
    if (span.text.length <= remaining) {
      remaining -= span.text.length;
      spans.pop();
    } else {
      span.text = span.text.slice(0, span.text.length - remaining);
      remaining = 0;
    }
  }
}

function pushSpan(spans: ReadableSpan[], span: ReadableSpan) {
  const previous = spans[spans.length - 1];
  if (previous && sameStyle(previous, span)) previous.text += span.text;
  else spans.push(span);
}

/** The eight one-dot braille cells. Codex (0.155) scatters them around its
 * composer as an animated sparkle, a new pattern every repaint — over the
 * blank rows, and on the input line itself (`›⠁Ask Codex…`), where one next to
 * the marker hid the input box from `statusLine`, so the frame cut and the
 * facts flipped with every frame. No spinner or text is made of lone dots, so
 * each is read as the blank cell it decorates; denser braille (spinners,
 * plots) is kept. */
const SPARKLE = /[\u2801\u2802\u2804\u2808\u2810\u2820\u2840\u2880]/gu;
const SPARKLE_CELL = /^[\u2801\u2802\u2804\u2808\u2810\u2820\u2840\u2880]$/u;

/** One buffer row as styled spans, padding included.
 *
 * Trailing blanks are *not* dropped here: a row that continues on the next one
 * can legitimately end in a space, and trimming it per row glued the last word
 * of one row to the first of the next ("come from" + "the session" read as
 * "come fromthe session"). The trim happens once the logical line is complete.
 */
function rowSpans(line: ReadableLineLike): ReadableSpan[] {
  if (typeof line.getCell !== "function") {
    const plain = line.translateToString().replace(SPARKLE, " ");
    return plain ? [{ text: plain }] : [];
  }
  const spans: ReadableSpan[] = [];
  const width = line.length ?? line.translateToString().length;
  let cell: ReadableCellLike | undefined;
  for (let x = 0; x < width; x += 1) {
    cell = line.getCell(x, cell);
    if (!cell) break;
    // Width 0 is the trailing half of a wide glyph, already carried by the
    // cell before it.
    if (cell.getWidth() === 0) continue;
    const chars = cell.isInvisible() ? " ".repeat(cell.getChars().length || 1) : cell.getChars() || " ";
    // A sparkle takes no style either: a coloured blank would still be a span.
    if (SPARKLE_CELL.test(chars)) {
      pushSpan(spans, { text: " " });
      continue;
    }
    pushSpan(spans, { text: chars, ...styleOf(cell) });
  }
  return spans;
}

/** Drops the blank cells a row is padded to the window width with. A styled
 * background would otherwise stretch a highlight across the whole screen. */
function trimTrailing(spans: ReadableSpan[]) {
  const text = spanText(spans);
  const trailing = text.length - text.replace(/\s+$/u, "").length;
  if (trailing > 0) trimSpansRight(spans, trailing);
  return spans;
}

function spanText(spans: ReadableSpan[]) {
  return spans.map((span) => span.text).join("");
}

/** Strips the frame an agent draws around its input box and dialogs. This is
 * decoration removal, not content filtering: a row that also carries text keeps
 * the text, a row made only of frame is `"border"`, and an empty row is
 * `"blank"` — the two are not the same, because a dropped border must not open
 * a paragraph break where the program drew none. */
function undecorate(spans: ReadableSpan[]): ReadableSpan[] | "blank" | "border" {
  const text = spanText(spans);
  if (!text.trim()) return "blank";
  if (BORDER_ONLY.test(text)) return "border";
  const left = LEFT_EDGE.exec(text);
  if (left) trimSpansLeft(spans, left[0].length);
  const right = RIGHT_EDGE.exec(spanText(spans));
  if (right) trimSpansRight(spans, right[0].length);
  return spans.length ? spans : "blank";
}

/** A rule that runs to the end of its row, with a gutter of blanks before it —
 * the edge of a panel drawn beside the conversation rather than across it. */
const SIDE_RULE = /(?:^|\s{2})[─━]{12,}$/u;
/** A rule starting left of this is the screen's own, not a side panel's. */
const MIN_SIDE_COLUMN = 24;

/**
 * Cuts a side panel off the rows it shares with the conversation, in place.
 * Claude Code can draw a diff view to the right of its transcript in the same
 * terminal rows; read whole, each such row was a line of the answer glued to a
 * line of the diff, and the chat layout put the diff into the prompt bubble
 * beside it. The panel is found by its own rules — at least two that start at
 * the same column and run to the end of the row — and cut from the block of
 * rows around them that keep a blank gutter before that column, so the input
 * frame and a full-width row printed before the panel opened stay whole.
 * Columns are counted in characters: a wide glyph left of the panel shifts
 * that row's cut by one.
 */
function cutSidePanel(rows: ReadableSpan[][]) {
  const texts = rows.map((spans) => spanText(spans).replace(/\s+$/u, ""));
  const byColumn = new Map<number, number[]>();
  texts.forEach((text, index) => {
    const match = SIDE_RULE.exec(text);
    if (!match) return;
    const column = match.index + match[0].length - match[0].trimStart().length;
    if (column >= MIN_SIDE_COLUMN) byColumn.set(column, [...(byColumn.get(column) ?? []), index]);
  });
  let column = -1;
  let ruleRows: number[] = [];
  byColumn.forEach((indexes, candidate) => {
    if (indexes.length >= 2 && indexes.length > ruleRows.length) {
      column = candidate;
      ruleRows = indexes;
    }
  });
  if (column < 0) return;
  const gutter = (text: string) => text.length <= column - 2 || text.slice(column - 2, column) === "  ";
  let top = ruleRows[0];
  while (top > 0 && gutter(texts[top - 1])) top -= 1;
  let bottom = ruleRows[ruleRows.length - 1];
  while (bottom < texts.length - 1 && gutter(texts[bottom + 1])) bottom += 1;
  for (let index = top; index <= bottom; index += 1) {
    const width = spanText(rows[index]).length;
    if (width > column) trimSpansRight(rows[index], width - column);
  }
}

function capLine(line: ReadableLine): ReadableLine {
  if (line.text.length <= MAX_LINE) return line;
  const spans = line.spans.slice();
  trimSpansRight(spans, line.text.length - MAX_LINE);
  const marker = `… ${translate(useI18nStore.getState().lang, "mobile.focus.lineTruncated")}`;
  spans.push({ text: marker, className: "d" });
  return { ...line, text: `${line.text.slice(0, MAX_LINE)}${marker}`, spans };
}

/**
 * Builds readable lines for buffer rows [first, end). Physical rows that xterm
 * wrapped are rejoined into the logical line the program emitted, so the phone
 * re-wraps at *its* width instead of showing the desktop tmux window's column
 * count as hard breaks.
 *
 * `afterText` is the text of the rendered line directly above this range. Blank
 * collapsing needs it at the seam: when the ranges above and below are built in
 * separate passes (the lazy history and the live tail), a paragraph break at
 * the start of this range survives exactly when the line above it holds text —
 * the same result one pass over both would produce. Absent or blank, leading
 * blanks are dropped, which is also how the whole-screen build never opens
 * with one.
 */
export function readableRange(
  buffer: ReadableBufferLike,
  first: number,
  end: number,
  afterText?: string,
): ReadableLine[] {
  const joined: ReadableLine[] = [];
  const physical: { row: number; wrapped: boolean; spans: ReadableSpan[] }[] = [];
  for (let row = first; row < end; row += 1) {
    const bufferLine = buffer.getLine(row);
    if (bufferLine) physical.push({ row, wrapped: bufferLine.isWrapped === true, spans: rowSpans(bufferLine) });
  }
  cutSidePanel(physical.map((entry) => entry.spans));

  for (const { row, wrapped, spans } of physical) {
    const previous = joined[joined.length - 1];
    if (wrapped && previous) {
      // A wrapped continuation belongs to the line above it: join first, and
      // let the trim and the frame stripping run over the completed line.
      spans.forEach((span) => pushSpan(previous.spans, span));
      continue;
    }
    joined.push({ key: `r${row}`, text: "", spans });
  }
  joined.forEach((line) => { line.text = spanText(trimTrailing(line.spans)); });

  const lines: ReadableLine[] = [];
  let ruled = false;
  for (const line of joined) {
    const spans = undecorate(line.spans);
    if (spans === "border") {
      ruled = true;
      continue;
    }
    const afterRule = ruled;
    ruled = false;
    if (spans === "blank") {
      // Collapse a run of blank rows — a repainting TUI leaves plenty — into a
      // single paragraph break, and never open the range with one unless the
      // caller says real text stands directly above it.
      const previousText = lines.length > 0 ? lines[lines.length - 1].text : afterText ?? "";
      if (previousText !== "") {
        lines.push({ key: `${line.key}b`, text: "", spans: [] });
      }
      continue;
    }
    const text = spanText(spans);
    if (LABELLED_RULE.test(text)) {
      trimSpansRight(spans, RULE_RIGHT.exec(text)![0].length);
      trimSpansLeft(spans, RULE_LEFT.exec(text)![0].length);
      lines.push(capLine({ key: line.key, text: spanText(spans), spans, frameText: text, ...(afterRule && { afterRule }) }));
    } else {
      lines.push(capLine({ key: line.key, text, spans, ...(afterRule && { afterRule }) }));
    }
  }
  return lines;
}

/**
 * Builds the bounded reading view: the last `maxRows` rows of the buffer,
 * capped to MAX_LINES logical lines. The fallback shape — the lazy history in
 * `readableHistory.ts` extends the same rendering backwards without the caps.
 */
export function readableScreen(buffer: ReadableBufferLike, maxRows = MAX_ROWS): ReadableScreen {
  const first = Math.max(0, buffer.length - maxRows);
  let clipped = first > 0;
  const lines = readableRange(buffer, first, buffer.length);
  while (lines.length > 0 && lines[lines.length - 1].text === "") lines.pop();

  if (lines.length > MAX_LINES) clipped = true;
  return { lines: lines.slice(-MAX_LINES), clipped };
}

/**
 * The same lines without the indent they all share. A TUI draws a dialog's
 * question two or four columns in, under its frame; a caller that shows that
 * text as its own — the phone's question heading, where the rows below it are
 * already a list of its own — wants it flush against the rest of its layout.
 * Blank lines neither count towards the shared indent nor lose anything.
 */
export function dedentLines(lines: readonly ReadableLine[]): ReadableLine[] {
  let indent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (!line.text.trim()) continue;
    indent = Math.min(indent, line.text.length - line.text.trimStart().length);
  }
  if (!Number.isFinite(indent) || indent <= 0) return [...lines];
  return lines.map((line) => {
    if (!line.text.trim()) return line;
    const spans = line.spans.map((span) => ({ ...span }));
    trimSpansLeft(spans, indent);
    return { ...line, text: line.text.slice(indent), spans };
  });
}

/** A row that opens something of its own rather than continuing a sentence: a
 * list item, an agent's message or tool marker, a quote, a frame. */
const BLOCK_OPENER = /^\s*(?:(?:[-*+•●⏺⎿>›❯☐☒☑✔✓]|\d{1,3}[.)])\s|[│┃┆┌┏╭╔└┗╰╚├┣─━═])/u;

/**
 * The same lines with a TUI's own word wrap undone, so the phone re-wraps the
 * prose at *its* width. Claude Code lays its text out itself and prints every
 * row as a line of its own, so xterm never marks one as a continuation
 * (`readableRange` rejoins only those) and a dialog's question arrived as the
 * pane's column count in hard breaks — re-wrapped again at phone width into
 * ragged half-lines.
 *
 * The wrap width is not printed anywhere, so it is read off the block: no row
 * is wider than it, and a greedy wrap breaks a row only when the next word
 * would not have fitted after it. A row that ends with room to spare for that
 * word, measured against the widest row, was broken on purpose and stays
 * broken. Blank rows and rows that open a block of their own never join. Only
 * for text known to be prose — a diff or a table would be read as wrapped.
 */
export function joinProseWraps(lines: readonly ReadableLine[]): ReadableLine[] {
  let width = 0;
  for (const line of lines) width = Math.max(width, line.text.trimEnd().length);
  const out: ReadableLine[] = [];
  /** The last *physical* row appended — what the wrap measured — not the line
   * it has been joined onto. */
  let physical = "";
  for (const line of lines) {
    const previous = out[out.length - 1];
    const before = physical.trimEnd();
    physical = line.text;
    const rest = line.text.trimStart();
    const word = /^\S+/u.exec(rest)?.[0] ?? "";
    const wrapped = previous !== undefined && before !== "" && rest !== ""
      && !BLOCK_OPENER.test(line.text) && before.length + 1 + word.length > width;
    if (!wrapped) {
      out.push({ ...line });
      continue;
    }
    const spans = line.spans.map((span) => ({ ...span }));
    trimSpansLeft(spans, line.text.length - rest.length);
    const head = previous.text.trimEnd();
    const headSpans = previous.spans.map((span) => ({ ...span }));
    trimSpansRight(headSpans, previous.text.length - head.length);
    out[out.length - 1] = { ...previous, text: `${head} ${rest}`, spans: [...headSpans, { text: " " }, ...spans] };
  }
  return out;
}

/** `dedentLines` for rows that are already plain text — the status strip's
 * (`statusFrameLines`). A fullscreen TUI centres its box, so those rows can
 * arrive 70 columns in on a wide pane; the strip is a phone-width readout of
 * them, not a scale model of the desktop window. Rows that start at the margin
 * lose nothing. */
export function dedentRows(rows: readonly string[]): string[] {
  let indent = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (!row.trim()) continue;
    indent = Math.min(indent, row.length - row.trimStart().length);
  }
  if (!Number.isFinite(indent) || indent <= 0) return [...rows];
  return rows.map((row) => (row.trim() ? row.slice(indent) : row));
}

/** The plain text of what the reading view is showing, for Copy. */
export function readableText(lines: readonly ReadableLine[]) {
  return lines.map((line) => line.text).join("\n");
}
