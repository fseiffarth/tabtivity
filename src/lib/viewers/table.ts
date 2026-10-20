/**
 * Pure, dependency-free CSV/TSV parsing, sniffing, editing and sorting for the
 * table viewer (#40). No DOM, no React — unit-tested in isolation
 * (`src/__tests__/viewers/table.test.ts`).
 *
 * Two things are worth internalising before changing anything here:
 *
 *  - **The separator is guessed, not known.** `.csv` says nothing about which
 *    character separates the columns: a European export is `;`-delimited, a pipe
 *    dump `|`-delimited, and both are called `.csv`. Assuming "comma" from the
 *    extension is exactly what makes such a file render as a single column. So
 *    the delimiter is *sniffed* from the content, and stays user-overridable —
 *    see {@link sniffDelimiter}.
 *
 *  - **The table is a view on the text, not a model of it.** Every edit
 *    ({@link replaceCell}, {@link insertRowAfter}, {@link deleteRow}) is a
 *    surgical splice into the source string, addressed by the spans
 *    {@link parseTable} hands back — never a re-serialisation of the parsed
 *    rows. That is the only way editing one cell leaves every *other* cell
 *    byte-for-byte alone, keeping each field's original quoting style, the
 *    file's line endings and its delimiter. It is the same bargain
 *    `lib/viewers/yaml.ts` strikes to keep a config file's comments.
 */

/** A leading UTF-8 BOM that some editors prepend; skipped, never sliced off. */
const BOM = "﻿";

/** The source range of one parsed field, as offsets into the *original* text. */
export interface CellSpan {
  /** Offset of the field's first character (inclusive). */
  start: number;
  /** Offset one past the field's last character (exclusive). */
  end: number;
}

/** The source range of one parsed row, as offsets into the *original* text. */
export interface RowSpan {
  /** Offset of the row's first character (inclusive). */
  start: number;
  /** Offset one past the row's last character, EXCLUDING its line terminator. */
  end: number;
  /**
   * Offset one past the row's line terminator — equal to `end` for a final row
   * the file leaves unterminated. That equality is how the edit ops tell "this
   * row ends with a newline" from "this row ends with the file".
   */
  next: number;
}

/** {@link parseTable}'s result: the cells, and where each one came from. */
export interface ParsedTable {
  /** Row-major cell values, quoting already decoded. */
  rows: string[][];
  /** `cells[r][c]` is the source span of `rows[r][c]`. Same shape as `rows`. */
  cells: CellSpan[][];
  /** `rowSpans[r]` is the source span of `rows[r]`. */
  rowSpans: RowSpan[];
  /** The file's dominant line terminator, used when a new row is inserted. */
  newline: string;
}

/**
 * A row paired with its index into {@link ParsedTable.rows}. Filtering and
 * sorting reorder and drop rows, so a row on screen can no longer say where it
 * came from — but an edit has to splice the row it *actually* came from. The
 * index is what survives the reordering.
 */
export interface RowRef {
  cells: string[];
  /** Index into `ParsedTable.rows` — so `0` is the header, `1` the first body row. */
  index: number;
}

/**
 * Parse `text` as RFC 4180 delimited data with the given single-character
 * `delimiter`, recording the source span of every cell and row so the result can
 * be edited by splicing rather than re-serialising.
 *
 * Handles:
 *  - quoted fields (`"…"`) that may contain the delimiter, CR, LF, or CRLF;
 *  - the `""` escape for a literal double-quote inside a quoted field;
 *  - CRLF and bare-LF (and bare-CR) line endings;
 *  - a leading BOM, skipped — offsets stay absolute into the original text, so a
 *    span can be spliced straight back into it;
 *  - a single trailing newline — it does NOT emit a trailing empty row.
 *
 * A quote that appears mid-field in an unquoted context is treated as a literal
 * character (lenient, like most spreadsheet importers), so malformed input still
 * yields cells rather than throwing.
 */
export function parseTable(text: string, delimiter: string): ParsedTable {
  // Skip a BOM by starting past it rather than slicing it away: every span must
  // index into the caller's string, or splicing one back would be off by one.
  const begin = text.startsWith(BOM) ? 1 : 0;

  const rows: string[][] = [];
  const cells: CellSpan[][] = [];
  const rowSpans: RowSpan[] = [];

  let row: string[] = [];
  let rowCells: CellSpan[] = [];
  let field = "";
  let fieldStart = begin;
  let rowStart = begin;
  let inQuotes = false;
  // Tracks whether the current row has seen any content, so we can decide
  // whether a final dangling row (after a trailing newline) should be emitted.
  let rowStarted = false;

  const pushField = (end: number) => {
    row.push(field);
    rowCells.push({ start: fieldStart, end });
    field = "";
  };
  const pushRow = (end: number, next: number) => {
    pushField(end);
    rows.push(row);
    cells.push(rowCells);
    rowSpans.push({ start: rowStart, end, next });
    row = [];
    rowCells = [];
    rowStarted = false;
    fieldStart = next;
    rowStart = next;
  };

  for (let i = begin; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          // Escaped quote inside a quoted field.
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    // Only a quote that opens a field starts a quoted region; one that turns up
    // mid-field is a literal character, as the docstring promises.
    if (ch === '"' && field === "") {
      inQuotes = true;
      rowStarted = true;
      continue;
    }
    if (ch === delimiter) {
      pushField(i);
      fieldStart = i + 1;
      rowStarted = true;
      continue;
    }
    if (ch === "\r") {
      // Treat CRLF as one line ending; a bare CR also ends the line.
      const crlf = text[i + 1] === "\n";
      pushRow(i, crlf ? i + 2 : i + 1);
      if (crlf) i++;
      continue;
    }
    if (ch === "\n") {
      pushRow(i, i + 1);
      continue;
    }
    field += ch;
    rowStarted = true;
  }

  // Flush the final field/row unless the input ended exactly on a row terminator
  // (a single trailing newline must not produce a trailing empty row).
  if (rowStarted || field !== "" || row.length > 0 || inQuotes) {
    pushRow(text.length, text.length);
  }

  return {
    rows,
    cells,
    rowSpans,
    newline: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

/** {@link parseTable}, when only the values are wanted. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  return parseTable(text, delimiter).rows;
}

// ── Choosing the separator ───────────────────────────────────────────────────

/** The separators {@link sniffDelimiter} considers, and the viewer offers. */
export const DELIMITER_CANDIDATES = [",", ";", "\t", "|"] as const;

/** How much of a large file to look at when sniffing, and how many rows of it. */
const SNIFF_CHARS = 64 * 1024;
const SNIFF_ROWS = 50;

/**
 * Guess which character separates the columns of `text`, falling back to
 * `fallback` when nothing splits it convincingly — a genuinely single-column
 * file has no delimiter to find, and inventing one would shred it.
 *
 * Each candidate is scored by parsing a sample of the file *with that candidate*
 * — so a comma sitting inside a quoted field can't fool the `;` reading — and
 * asking how rectangular the result is. The modal column count decides, on two
 * premises:
 *
 *  - a character that never splits a row (modal width 1) is not the delimiter,
 *    however consistently it fails to appear. This is what rejects `,` on a
 *    `;`-delimited file, where every row would otherwise score a perfect 1.0;
 *  - real tabular data is rectangular, so the delimiter yielding the *same* width
 *    on the most rows is the one the file was written with. Consistency therefore
 *    dominates the score, and the column count only breaks ties — in favour of
 *    the separator that explains more of the row.
 */
export function sniffDelimiter(text: string, fallback = ","): string {
  const truncated = text.length > SNIFF_CHARS;
  const sample = truncated ? text.slice(0, SNIFF_CHARS) : text;

  let best: string | null = null;
  let bestScore = -1;

  for (const candidate of DELIMITER_CANDIDATES) {
    const parsed = parseDelimited(sample, candidate);
    const rows = (truncated && parsed.length > 1 ? parsed.slice(0, -1) : parsed)
      // A sample cut mid-row reports a short final row that isn't real (above);
      // blank lines say nothing about the delimiter either way.
      .slice(0, SNIFF_ROWS)
      .filter((r) => !(r.length === 1 && r[0].trim() === ""));
    if (rows.length === 0) continue;

    const freq = new Map<number, number>();
    for (const r of rows) freq.set(r.length, (freq.get(r.length) ?? 0) + 1);

    let mode = 0;
    let modeCount = 0;
    for (const [width, count] of freq) {
      // On a tie, the wider reading wins — it explains more of the row.
      if (count > modeCount || (count === modeCount && width > mode)) {
        mode = width;
        modeCount = count;
      }
    }
    if (mode < 2) continue; // splits nothing ⇒ not the delimiter

    const score = (modeCount / rows.length) * 100 + Math.min(mode, 50);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best ?? fallback;
}

/** The separator a path's extension implies: `.tsv` → tab, else comma. */
export function delimiterForPath(path: string): string {
  return /\.tsv$/i.test(path) ? "\t" : ",";
}

/**
 * The separator to open `path` with: sniffed from the content, falling back to
 * what the extension implies when the content is inconclusive — so a one-column
 * `.tsv` still reads as a TSV.
 */
export function resolveDelimiter(path: string, text: string): string {
  return sniffDelimiter(text, delimiterForPath(path));
}

// ── Editing: splices, never re-serialisation ─────────────────────────────────

/**
 * Encode one value as a field, quoting only when the value would otherwise be
 * misread: it contains the delimiter, a quote, a newline, or leading/trailing
 * whitespace that a reader would be free to trim.
 */
export function encodeCell(value: string, delimiter: string): string {
  const ambiguous =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r") ||
    value !== value.trim();
  return ambiguous ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Return `text` with the cell at (`row`, `col`) set to `value`, splicing only
 * that one field's span so every other byte of the file survives untouched.
 *
 * When `col` lies past the end of a **ragged** row, the row is padded out with
 * empty fields first: the viewer pads short rows to the table's full width on
 * screen, so a cell can be visible in a row that holds no such field, and typing
 * into it must write where it appears rather than land in the wrong column.
 */
export function replaceCell(
  text: string,
  table: ParsedTable,
  row: number,
  col: number,
  value: string,
  delimiter: string,
): string {
  const spans = table.cells[row];
  if (!spans || spans.length === 0 || col < 0) return text;
  const encoded = encodeCell(value, delimiter);

  if (col < spans.length) {
    const span = spans[col];
    return text.slice(0, span.start) + encoded + text.slice(span.end);
  }

  const last = spans[spans.length - 1];
  const padding = delimiter.repeat(col - spans.length + 1);
  return text.slice(0, last.end) + padding + encoded + text.slice(last.end);
}

/** Return `text` with a blank `width`-column row inserted after `row`. */
export function insertRowAfter(
  text: string,
  table: ParsedTable,
  row: number,
  width: number,
  delimiter: string,
): string {
  const span = table.rowSpans[row];
  if (!span) return text;
  const blank = delimiter.repeat(Math.max(0, width - 1));
  // A terminated row already ends in a newline, so the blank row follows it and
  // brings its own. An unterminated final row needs the newline first — and must
  // stay unterminated, or the file grows a trailing blank line it never had.
  const terminated = span.next > span.end;
  const insert = terminated ? blank + table.newline : table.newline + blank;
  return text.slice(0, span.next) + insert + text.slice(span.next);
}

/** Return `text` with `row` removed, taking exactly one line terminator with it. */
export function deleteRow(text: string, table: ParsedTable, row: number): string {
  const span = table.rowSpans[row];
  if (!span) return text;
  // Normally a row takes its own trailing terminator with it. A final,
  // unterminated row has none — so it takes the *preceding* one instead, rather
  // than leaving the file ending on a dangling newline.
  if (span.next > span.end) {
    return text.slice(0, span.start) + text.slice(span.next);
  }
  const previous = row > 0 ? table.rowSpans[row - 1] : null;
  const from = previous ? previous.end : span.start;
  return text.slice(0, from) + text.slice(span.next);
}

// ── Filtering, sorting, layout ───────────────────────────────────────────────

/** The body rows (everything below the header), each keeping its source index. */
export function bodyRefs(rows: string[][]): RowRef[] {
  const refs: RowRef[] = [];
  for (let i = 1; i < rows.length; i++) refs.push({ cells: rows[i], index: i });
  return refs;
}

/**
 * The rows in which some cell contains `query`, case-insensitively. A blank query
 * matches everything rather than nothing, so clearing the box restores the table.
 *
 * `cols` restricts the search to those column indices — the columns the reader can
 * actually **see**. A row matched on a hidden column would appear in the results
 * with nothing on it to explain why, which reads as a bug in the filter.
 */
export function filterRefs(refs: RowRef[], query: string, cols?: number[]): RowRef[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return refs;
  const hit = (v: string) => v.toLowerCase().includes(needle);
  if (!cols) return refs.filter((r) => r.cells.some(hit));
  return refs.filter((r) => cols.some((c) => hit(r.cells[c] ?? "")));
}

/**
 * Whether every cell in `values` parses as a finite number (so the column should
 * sort numerically). An empty input or an empty/blank cell makes it non-numeric,
 * since a blank can't be ordered numerically against real numbers.
 */
function allNumeric(values: string[]): boolean {
  if (values.length === 0) return false;
  for (const v of values) {
    const t = v.trim();
    if (t === "") return false;
    const n = Number(t);
    if (!Number.isFinite(n)) return false;
  }
  return true;
}

/**
 * Return a new copy of `refs` sorted by column `col` in direction `dir`. Numeric
 * comparison is used when every cell in that column parses as a finite number;
 * otherwise `localeCompare`. Missing cells (ragged rows) are treated as empty
 * strings. Does not mutate the input. Stable for equal keys.
 */
export function sortRefs(refs: RowRef[], col: number, dir: "asc" | "desc"): RowRef[] {
  const numeric = allNumeric(refs.map((r) => r.cells[col] ?? ""));
  // Decorate with the current position for a stable sort across engines.
  const indexed = refs.map((r, i) => ({ r, i }));
  indexed.sort((a, b) => {
    const av = a.r.cells[col] ?? "";
    const bv = b.r.cells[col] ?? "";
    let cmp = numeric ? Number(av.trim()) - Number(bv.trim()) : av.localeCompare(bv);
    if (cmp === 0) cmp = a.i - b.i; // keep stable order for ties
    return dir === "asc" ? cmp : -cmp;
  });
  return indexed.map((x) => x.r);
}

/**
 * Return a new copy of `refs` ordered by each row's **source index** — the file's
 * own row order (`asc`) or its reverse (`desc`). This is what the row-number
 * gutter sorts on: the gutter shows each row's source index, so ordering by it
 * restores (asc) the order the rows have in the file — whatever a column sort did
 * to the view — or reverses it (desc). Does not mutate the input.
 */
export function sortRefsByIndex(refs: RowRef[], dir: "asc" | "desc"): RowRef[] {
  const sorted = [...refs].sort((a, b) => a.index - b.index);
  return dir === "asc" ? sorted : sorted.reverse();
}

/** {@link sortRefs} over bare rows, for callers with no source indices to keep. */
export function sortRows(
  rows: string[][],
  col: number,
  dir: "asc" | "desc",
): string[][] {
  const refs = rows.map((cells, index) => ({ cells, index }));
  return sortRefs(refs, col, dir).map((r) => r.cells);
}

/** Rows sampled when measuring column widths — enough to be representative. */
const WIDTH_SAMPLE_ROWS = 1000;
/** Width bounds, in characters, before the cell's own padding. */
const MIN_WIDTH_CH = 4;
const MAX_WIDTH_CH = 48;

/**
 * The display width of each of the table's `width` columns, in characters.
 *
 * Measured **once over the whole table**, not over what happens to be on screen,
 * because the viewer only renders the rows in view: had each column sized itself
 * to its visible content, every column would resize as the reader scrolled. A
 * sample bounds the cost on a huge file — a later row that overflows its column
 * is clipped, and the viewer offers the full value on hover, which is the price
 * of columns that hold still.
 */
export function columnWidths(rows: string[][], width: number): number[] {
  const widths = new Array<number>(width).fill(MIN_WIDTH_CH);
  const limit = Math.min(rows.length, WIDTH_SAMPLE_ROWS);
  for (let r = 0; r < limit; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length && c < width; c++) {
      if (row[c].length > widths[c]) widths[c] = row[c].length;
    }
  }
  return widths.map((w) => Math.min(w, MAX_WIDTH_CH));
}

/** What a cell's text reads as, for colouring: a number, a boolean, a
 *  missing-value marker, a date/time, a URL — or `null`, plain text. */
export type CellTone = "num" | "bool" | "null" | "date" | "url";

const CELL_BOOL = /^(true|false)$/i;
const CELL_NULL = /^(null|none|nil|nan|na|n\/a)$/i;
const CELL_DATE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const CELL_URL = /^https?:\/\/\S+$/i;

/** Classify one cell by its text alone (not its column), so a stray `n/a` in a
 *  numeric column still reads as missing. A blank cell is plain. */
export function cellTone(value: string): CellTone | null {
  const t = value.trim();
  if (t === "") return null;
  if (Number.isFinite(Number(t))) return "num";
  if (CELL_BOOL.test(t)) return "bool";
  if (CELL_NULL.test(t)) return "null";
  if (CELL_DATE.test(t)) return "date";
  if (CELL_URL.test(t)) return "url";
  return null;
}

/** The colour a tone paints with: the theme's document hue when it declares
 *  one (the `--doc-*` set, plain `dark`/`light` today), else the cell's own text
 *  colour — every other theme renders the grid exactly as before. */
export const CELL_TONE_COLOR: Record<CellTone, string> = {
  num: "var(--doc-yellow, currentColor)",
  bool: "var(--doc-purple, currentColor)",
  null: "var(--doc-grey, currentColor)",
  date: "var(--doc-cyan, currentColor)",
  url: "var(--doc-link, currentColor)",
};

/** Inline `color` for a cell, or `undefined` for plain text. */
export function cellToneColor(value: string): string | undefined {
  const tone = cellTone(value);
  return tone ? CELL_TONE_COLOR[tone] : undefined;
}

/** A cell's text as one screen line: a quoted field's line breaks show as `↵`.
 *  The table is windowed on a fixed row height, so a cell that wrapped onto a
 *  second line would grow its row and throw every row below it off the scroll
 *  arithmetic. The value itself is untouched (tooltip, editor, splice). */
export function cellDisplayText(value: string): string {
  return value.replace(/\r\n|\r|\n/g, "↵");
}
