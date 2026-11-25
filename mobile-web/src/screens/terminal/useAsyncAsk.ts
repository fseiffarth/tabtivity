// Codex's async question (`request_user_input_async`, 0.169.0) answered from
// the chat. The agent works on while it waits in Codex's queue, which nothing
// on the screen shows but a `? 1 question · shift+← to answer` hint; the chat
// shows it from the conversation (`TranscriptEntry.asking`). A tap on a row
// opens Codex's own picker (shift+←) and, once the live screen reads it as
// that question (`readQueuedPicker`), walks the highlight to the row there —
// the same keys a live question's tap sends (`useLiveQuestion`).
import { useCallback, useEffect, useMemo, useState } from "react";
import { type AskedQuestion } from "../../api";
import { type ReadableLine } from "../../terminal/readableScreen";
import { selectKeys } from "../../terminal/selectPrompt";
import { MODEL_PICKER_WAIT } from "./terminalShared";

/** shift+← — Codex opens the oldest queued question. */
export const OPEN_QUEUED_QUESTION = "\u001b[1;2D";

/** The row a tap answers with, while Codex's picker is coming up. */
export type AsyncAskSending = { key: string; question: number; row: number; asked: AskedQuestion };

export type AsyncAsk = {
  sending: AsyncAskSending | null;
  /** `key`: the chat turn; `asked`: the question as the agent asked it, whose
   * words and options the picker must match before a row is taken. */
  pick: (key: string, asked: AskedQuestion, question: number, row: number) => void;
};

const words = (text: string) => text.replace(/\s+/gu, " ").trim();

/** The footer Codex draws under the queue's picker. Once the rows are taller
 * than the area it also says `option N/M` (the highlight, of the rows with
 * `Other`), and a narrow pane wraps it over two lines. */
const PICKER_FOOTER = /^enter submit \^\] skip (?:option (\d+)\/(\d+) )?shift\+→ main prompt$/u;
const PICKER_ROW = /^\s*([›>])?\s*(\d{1,2})\.\s+(\S.*)$/u;
/** The asks Tabtivity keeps carry at most this many options. */
const MAX_ASKED_OPTIONS = 12;
/** Lines under the footer's start it may take up, and that may follow it. */
const FOOTER_REACH = 4;
/** Longest wrapped title, in lines. */
const WRAP_REACH = 6;

/** The queue's picker as it is on screen: the highlighted row's printed number
 * (1-based, `Other` last). */
export type QueuedPicker = { current: number };

/** The footer of Codex's queue picker among the last lines, and where it
 * starts. It is what says the picker is the queue's, not a blocking question's. */
export function queuedPickerFooter(lines: readonly { text: string }[]): { start: number; highlight?: number; total?: number } | null {
  const filled: number[] = [];
  for (let index = lines.length - 1; index >= 0 && filled.length < FOOTER_REACH; index -= 1) if (lines[index].text.trim()) filled.unshift(index);
  for (let first = filled.length - 1; first >= 0; first -= 1) {
    if (!words(lines[filled[first]].text).startsWith("enter submit")) continue;
    const found = PICKER_FOOTER.exec(words(filled.slice(first).map((index) => lines[index].text).join(" ")));
    if (found) return { start: filled[first], ...(found[1] ? { highlight: Number(found[1]), total: Number(found[2]) } : {}) };
  }
  return null;
}

/** The queue's picker when it is the one asking `asked`, however much of its
 * list the area shows. A list taller than the area scrolls with the highlight
 * and drops the queue's heading, so the question is found by its words above
 * the rows, and each row seen is held to the asked option of that number
 * (the last row seen may be cut short; `Other` follows the options). `null`
 * for another question, a blocking one, or rows that do not add up. */
export function readQueuedPicker(
  lines: readonly { text: string }[],
  asked: { question: string; options?: readonly { label: string }[] },
): QueuedPicker | null {
  const options = asked.options ?? [];
  const question = words(asked.question);
  const footer = queuedPickerFooter(lines);
  if (!footer || !question || options.length === 0) return null;
  let rows = -1;
  for (let start = footer.start - 1; start >= 0 && rows < 0; start -= 1) {
    for (let end = start; end < Math.min(footer.start, start + WRAP_REACH); end += 1) {
      if (words(lines.slice(start, end + 1).map((line) => line.text).join(" ")) === question) {
        rows = end + 1;
        break;
      }
    }
  }
  if (rows < 0) return null;
  const seen: { number: number; label: string; marked: boolean }[] = [];
  for (let index = rows; index < footer.start; index += 1) {
    const text = lines[index].text;
    if (!text.trim()) continue;
    const row = PICKER_ROW.exec(text);
    const last = seen[seen.length - 1];
    if (row && (!last || Number(row[2]) === last.number + 1)) seen.push({ number: Number(row[2]), label: words(row[3]), marked: !!row[1] });
    else if (last) last.label = words(`${last.label} ${text}`);
  }
  if (seen.length === 0) return null;
  const marked = seen.filter((row) => row.marked);
  if (marked.length > 1) return null;
  if (footer.highlight !== undefined && marked[0] && footer.highlight !== marked[0].number) return null;
  const current = marked[0]?.number ?? footer.highlight;
  if (current === undefined) return null;
  const total = options.length + 1;
  // A list that fits shows every row; a taller one says how many it has.
  if (footer.total === undefined ? seen.length !== total || seen[0].number !== 1 : footer.total !== total && options.length < MAX_ASKED_OPTIONS) return null;
  for (const [position, row] of seen.entries()) {
    if (row.number > total) return null;
    if (row.number === total) {
      if (row.label !== "Other") return null;
      continue;
    }
    const label = words(options[row.number - 1].label);
    if (label !== row.label && !(position === seen.length - 1 && label.startsWith(row.label))) return null;
  }
  return { current };
}

/** The keys that walk the picker's highlight to option `row` (0-based) and
 * accept it. */
export function queuedPickerKeys(picker: QueuedPicker, row: number): string[] {
  return selectKeys(picker.current - 1, row);
}

export function useAsyncAsk({ deliver, liveTail }: {
  deliver: (writes: string[]) => boolean;
  liveTail: readonly ReadableLine[];
}): AsyncAsk {
  const [sending, setSending] = useState<AsyncAskSending | null>(null);
  const pick = useCallback((key: string, asked: AskedQuestion, question: number, row: number) => {
    const next = { key, question, row, asked };
    // Its picker is up already (opened from the keys bar, or a tap before).
    const picker = readQueuedPicker(liveTail, asked);
    if (picker) {
      if (asked.options?.[row]) deliver(queuedPickerKeys(picker, row));
      return;
    }
    if (deliver([OPEN_QUEUED_QUESTION])) setSending(next);
  }, [deliver, liveTail]);
  useEffect(() => {
    if (!sending) return;
    const picker = readQueuedPicker(liveTail, sending.asked);
    if (!picker) return;
    // Codex lists the rows as asked, then its own `Other`.
    setSending(null);
    if (sending.asked.options?.[sending.row]) deliver(queuedPickerKeys(picker, sending.row));
  }, [sending, liveTail, deliver]);
  useEffect(() => {
    if (!sending) return;
    // Another question came up first (an older one in the queue), or none
    // did: the live card shows what is there; the tap is given back. Timed
    // from the tap alone — the working agent repaints every second.
    const timer = window.setTimeout(() => setSending(null), MODEL_PICKER_WAIT);
    return () => window.clearTimeout(timer);
  }, [sending]);
  return useMemo(() => ({ sending, pick }), [sending, pick]);
}
