/**
 * The Focus view's append-only memory of session lines — what makes "Show
 * earlier output" possible without re-walking the whole xterm buffer on every
 * frame.
 *
 * It works because scrollback rows above the live screen are immutable: xterm
 * only ever appends at the bottom and trims from the top. So each row is
 * converted to readable lines exactly once, when it leaves the tail window,
 * and the result is kept in frozen chunks the view can memoize and reveal
 * lazily. Only the tail — the live screen plus a small margin — is rebuilt per
 * frame, where the old whole-screen build re-walked 1200 rows each time.
 *
 * Buffer row indices shift when xterm trims its scrollback. The owner reports
 * each trim through {@link shiftHistory} so `end` keeps pointing at the same
 * content; line keys and chunk ids come from the monotonic `seq` counter for
 * the same reason — a `r<row>` key names a position, not a line.
 */

import { readableRange, type ReadableBufferLike, type ReadableLine } from "./readableScreen";

/** Lines per frozen chunk — the reveal granularity, and the bound on how many
 * rows the open (still-growing) chunk re-renders when output arrives. */
export const HISTORY_CHUNK = 400;
/** Frozen lines kept in memory; the oldest chunks beyond this are dropped and
 * counted in `droppedLines`, so the notice can stay honest. */
export const HISTORY_MAX_LINES = 20_000;

/** A finished block of earlier output. `lines` never changes after freezing,
 * which is what lets the view memoize a revealed chunk. */
export interface HistoryChunk {
  id: number;
  lines: readonly ReadableLine[];
}

export interface ReadableHistory {
  /** Frozen chunks, oldest first. The array is mutated in place; publish a
   * copy when handing it to render state. */
  chunks: HistoryChunk[];
  /** The chunk still being filled; replaced (never mutated) on append, so an
   * unchanged reference means unchanged content. */
  open: ReadableLine[];
  /** The first buffer row not yet absorbed, in current buffer coordinates. */
  end: number;
  /** Monotonic counter behind line keys and chunk ids. */
  seq: number;
  /** Absorbed lines discarded again by {@link HISTORY_MAX_LINES}. */
  droppedLines: number;
  /** The buffer trimmed rows away before they could be absorbed — content is
   * missing from the top with no count to name. */
  lost: boolean;
}

export function emptyHistory(): ReadableHistory {
  return { chunks: [], open: [], end: 0, seq: 0, droppedLines: 0, lost: false };
}

/** The buffer trimmed `trimmed` rows off its top; keep `end` on the same row. */
export function shiftHistory(history: ReadableHistory, trimmed: number) {
  history.end -= trimmed;
  if (history.end < 0) {
    // Rows were trimmed before absorption reached them (a flood faster than
    // the throttled rebuild). The content is gone; say so rather than absorb
    // the wrong rows.
    history.end = 0;
    history.lost = true;
  }
}

/** Subscribes to the trims of a scrollback; returns the unsubscribe. */
export type TrimEvent = (listener: (amount: number) => void) => { dispose(): void };

/** The trim emitter of `term`'s normal buffer — the event {@link shiftHistory}
 * is fed from — or undefined when there is none.
 *
 * xterm has no public event for a scrollback trim, so this reads the internal
 * buffer list's own `onTrim` (`_core._bufferService.buffers.normal.lines`),
 * guarded at every step: when a future xterm renames it, the owner falls back
 * to the bounded whole-screen rebuild instead of showing wrong lines. The
 * emitter belongs to one buffer, and `term.reset()` builds a new one, so read
 * it again after every reset. */
export function scrollbackTrimEvent(term: object): TrimEvent | undefined {
  const onTrim = (term as {
    _core?: { _bufferService?: { buffers?: { normal?: { lines?: { onTrim?: unknown } } } } };
  })._core?._bufferService?.buffers?.normal?.lines?.onTrim;
  return typeof onTrim === "function" ? (onTrim as TrimEvent) : undefined;
}

/** The text of the newest absorbed line — the seam context the tail rebuild
 * hands to `readableRange` so a paragraph break survives the boundary. */
export function lastHistoryText(history: ReadableHistory): string | undefined {
  const open = history.open;
  if (open.length > 0) return open[open.length - 1].text;
  const chunk = history.chunks[history.chunks.length - 1];
  const line = chunk?.lines[chunk.lines.length - 1];
  return line?.text;
}

/**
 * Absorb every buffer row older than the tail window into the history log.
 * Returns whether anything was appended, so the caller republishes its render
 * state only then.
 *
 * `tailRows` must cover at least the live screen: rows inside it can still be
 * repainted by the program, so they are the tail rebuild's to re-read, never
 * this log's.
 */
export function absorbHistory(
  buffer: ReadableBufferLike,
  history: ReadableHistory,
  tailRows: number,
): boolean {
  let target = Math.max(history.end, buffer.length - tailRows);
  // Never split a logical line: back the boundary off to the start of the
  // wrapped run it lands inside, so the tail rebuild re-joins the line whole.
  while (target > history.end && buffer.getLine(target)?.isWrapped) target -= 1;
  if (target <= history.end) return false;

  const lines = readableRange(buffer, history.end, target, lastHistoryText(history));
  history.end = target;
  if (lines.length === 0) return false;

  // Re-key on the monotonic counter: the `r<row>` keys the range builder mints
  // shift with the buffer on trim, and a React key that renames remounts.
  for (const line of lines) {
    line.key = `h${history.seq}`;
    history.seq += 1;
  }

  let open = history.open.concat(lines);
  while (open.length >= HISTORY_CHUNK) {
    history.chunks.push({ id: history.seq, lines: open.slice(0, HISTORY_CHUNK) });
    history.seq += 1;
    open = open.slice(HISTORY_CHUNK);
  }
  history.open = open;

  let frozen = history.chunks.reduce((sum, chunk) => sum + chunk.lines.length, 0);
  while (history.chunks.length > 0 && frozen > HISTORY_MAX_LINES) {
    const gone = history.chunks.shift()!;
    frozen -= gone.lines.length;
    history.droppedLines += gone.lines.length;
  }
  return true;
}
