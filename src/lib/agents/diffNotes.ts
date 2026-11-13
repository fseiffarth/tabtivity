import type { TranslationKey } from "../i18n";
import type { DiffLine } from "../viewers/diff";
import { splitDiffRows } from "../viewers/diffRows";

/**
 * Notes a user leaves on lines of the Reader's Diffs tab, and the one prompt
 * they are turned into (`docs/diff_notes_plan.md`). Pure: the store that holds
 * them is `stores/agents/diffNotes`, the UI `TerminalReaderChanges`.
 */

/** The side of the diff a note's line numbers are on: `old` only when every
 * selected line is a deletion. */
export type NoteSide = "new" | "old";

export interface DiffNote {
  id: string;
  /** As the card shows it (relative to the tab's folder when inside it). */
  path: string;
  side: NoteSide;
  from: number;
  to: number;
  /** The selected lines, each with its `+` / `-` / space marker. */
  quote: string[];
  text: string;
  at: number;
  /** Where the note sits on screen: the card's key, the hunk, and the
   * selected lines' indices in that hunk. Not part of the prompt. */
  card: string;
  hunk: number;
  lines: number[];
}

/** A quote shows at most this many lines. */
export const QUOTE_LINE_CAP = 12;
/** The prompt stays within this many characters (the first note always goes in). */
export const PROMPT_CHAR_CAP = 8000;

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

/** Whether a note can sit on this line: a diff body line, not a header. */
export function noteableLine(line: DiffLine): boolean {
  return line.type === "add" || line.type === "del" || line.type === "context";
}

/** The line as a quote: its `+` / `-` / space marker, a space, the text. */
export function quoteLine(line: DiffLine): string {
  const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
  return `${marker} ${line.text}`;
}

/**
 * The rows a gutter button can start a note on, each as the indices (into
 * `lines`) of the lines it shows: one per body line when unified; when split,
 * a context line once and a del/add pair together. The row's first index is
 * the key its note box hangs under.
 */
export function noteRows(lines: readonly DiffLine[], split: boolean): number[][] {
  if (!split) {
    const rows: number[][] = [];
    lines.forEach((line, index) => {
      if (noteableLine(line)) rows.push([index]);
    });
    return rows;
  }
  const indexOf = new Map<DiffLine, number>();
  lines.forEach((line, index) => indexOf.set(line, index));
  const rows: number[][] = [];
  for (const row of splitDiffRows(lines)) {
    if (row.note !== undefined) continue;
    const at: number[] = [];
    for (const line of [row.before, row.after]) {
      const index = line ? indexOf.get(line) : undefined;
      if (index !== undefined && !at.includes(index)) at.push(index);
    }
    if (at.length) rows.push(at);
  }
  return rows;
}

/** The lines of the rows from the one holding `anchor` to the one holding
 * `target` (either order), ascending; just `target`'s row when `anchor` is on
 * none, nothing when `target` is on none. */
export function rangeLines(rows: readonly number[][], anchor: number, target: number): number[] {
  const to = rows.findIndex((row) => row.includes(target));
  if (to < 0) return [];
  const from = rows.findIndex((row) => row.includes(anchor));
  const [first, last] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
  return [...new Set(rows.slice(first, last + 1).flat())].sort((a, b) => a - b);
}

/** The key a note box hangs under: the first line of the last row (in `rows`
 * order) that holds any of `lines`; null when none does. */
export function slotLine(rows: readonly number[][], lines: readonly number[]): number | null {
  for (let at = rows.length - 1; at >= 0; at--) {
    if (rows[at].some((index) => lines.includes(index))) return rows[at][0];
  }
  return null;
}

/** What a selection of a hunk's lines is, as a note records it. */
export function describeSelection(
  lines: readonly DiffLine[],
  indices: readonly number[],
): { side: NoteSide; from: number; to: number; quote: string[] } | null {
  const picked = [...indices]
    .sort((a, b) => a - b)
    .map((index) => lines[index])
    .filter((line): line is DiffLine => !!line && noteableLine(line));
  if (picked.length === 0) return null;
  const old = picked.every((line) => line.type === "del");
  const numbers = picked.map((line) => (old ? line.oldNo : line.newNo)).filter((no): no is number => no !== null);
  if (numbers.length === 0) return null;
  return {
    side: old ? "old" : "new",
    from: Math.min(...numbers),
    to: Math.max(...numbers),
    quote: picked.map(quoteLine),
  };
}

/** The index (into `lines`) of the first added or deleted line, else the first
 * body line; -1 when the hunk has none. */
export function firstNoteLine(lines: readonly DiffLine[]): number {
  const change = lines.findIndex((line) => line.type === "add" || line.type === "del");
  return change >= 0 ? change : lines.findIndex(noteableLine);
}

function rangeLabel(from: number, to: number): string {
  return from === to ? String(from) : `${from}-${to}`;
}

/** A fence longer than any backtick run inside the quote, so a quoted fence
 * cannot close it early. */
function fenceFor(quote: readonly string[]): string {
  let longest = 0;
  for (const line of quote) for (const run of line.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

function noteBlock(note: DiffNote, t: Translate): string {
  const range = rangeLabel(note.from, note.to);
  const head = note.side === "old"
    ? `${note.path} (${t(note.from === note.to ? "diffNotes.prompt.removedOne" : "diffNotes.prompt.removed", { range })})`
    : `${note.path}:${range}`;
  const shown = note.quote.slice(0, QUOTE_LINE_CAP);
  if (note.quote.length > shown.length) shown.push(t("diffNotes.prompt.more", { n: note.quote.length - shown.length }));
  const fence = fenceFor(shown);
  return `${head}\n${fence}diff\n${shown.join("\n")}\n${fence}\n→ ${note.text.trim()}`;
}

export interface DiffNotesPrompt {
  text: string;
  /** The notes the text holds, in the order they appear in it. */
  included: DiffNote[];
  /** How many notes did not fit within `PROMPT_CHAR_CAP`. */
  omitted: number;
}

/**
 * The prompt for `notes`: the lead line, then each note as its file and lines,
 * the quoted diff lines in a fence, and the note after an arrow. Notes of one
 * file stay together, files in the order they were first noted. The text stops
 * before the note that would pass `PROMPT_CHAR_CAP`; the first note always goes
 * in, however long.
 */
export function buildDiffNotesPrompt(notes: readonly DiffNote[], t: Translate): DiffNotesPrompt {
  const order: string[] = [];
  const byPath = new Map<string, DiffNote[]>();
  for (const note of notes) {
    if (!byPath.has(note.path)) {
      byPath.set(note.path, []);
      order.push(note.path);
    }
    byPath.get(note.path)?.push(note);
  }
  const ordered = order.flatMap((path) => byPath.get(path) ?? []);
  const blocks = [t("diffNotes.prompt.lead")];
  let length = blocks[0].length;
  const included: DiffNote[] = [];
  for (const note of ordered) {
    const block = noteBlock(note, t);
    if (included.length > 0 && length + 2 + block.length > PROMPT_CHAR_CAP) break;
    blocks.push(block);
    length += 2 + block.length;
    included.push(note);
  }
  return { text: blocks.join("\n\n"), included, omitted: ordered.length - included.length };
}
