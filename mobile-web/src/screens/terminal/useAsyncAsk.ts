// Codex's async question (`request_user_input_async`, 0.169.0) answered from
// the chat. The agent works on while it waits in Codex's queue, which nothing
// on the screen shows but a `? 1 question · shift+← to answer` hint; the chat
// shows it from the conversation (`TranscriptEntry.asking`). A tap on a row
// opens Codex's own picker (shift+←) and, once the live screen reads it as
// that question (`readSelectPrompt`), answers it with the row there — the
// same keys a live question's tap sends (`useLiveQuestion`).
import { useCallback, useEffect, useMemo, useState } from "react";
import { type ReadableLine } from "../../terminal/readableScreen";
import { type SelectOption, type SelectPrompt } from "../../terminal/selectPrompt";
import { MODEL_PICKER_WAIT } from "./terminalShared";

/** shift+← — Codex opens the oldest queued question. */
export const OPEN_QUEUED_QUESTION = "\u001b[1;2D";

/** The row a tap answers with, while Codex's picker is coming up. */
export type AsyncAskSending = { key: string; question: number; row: number; asked: string };

export type AsyncAsk = {
  sending: AsyncAskSending | null;
  /** `key`: the chat turn; `asked`: its question's text, which the picker's
   * heading must match before a row is taken. */
  pick: (key: string, asked: string, question: number, row: number) => void;
};

const words = (text: string) => text.replace(/\s+/gu, " ").trim();

/** The line Codex heads its queue with; the picker opened from it is drawn
 * right under it, its question first. */
const QUEUE_HEADING = "Queued follow-up inputs";

/** The picker on `tail` asks `asked`: the lines between the queue's heading
 * and its first row are the question, wrapped as the pane is wide. */
export function pickerAsks(prompt: SelectPrompt | null, tail: readonly { text: string }[], asked: string): boolean {
  const question = words(asked);
  if (!prompt || !question) return false;
  let from = prompt.start;
  while (from > 0 && !tail[from - 1].text.includes(QUEUE_HEADING)) from -= 1;
  if (from === 0) return false;
  return words(tail.slice(from, prompt.start).map((line) => line.text).join(" ")) === question;
}

export function useAsyncAsk({ deliver, liveTail, liveQuestion, answerQuestion }: {
  deliver: (writes: string[]) => boolean;
  liveTail: readonly ReadableLine[];
  liveQuestion: SelectPrompt | null;
  answerQuestion: (option: SelectOption) => void;
}): AsyncAsk {
  const [sending, setSending] = useState<AsyncAskSending | null>(null);
  const pick = useCallback((key: string, asked: string, question: number, row: number) => {
    const next = { key, question, row, asked };
    // Its picker is up already (opened from the keys bar, or a tap before).
    if (pickerAsks(liveQuestion, liveTail, asked)) {
      const option = liveQuestion?.options[row];
      if (option) answerQuestion(option);
      return;
    }
    if (deliver([OPEN_QUEUED_QUESTION])) setSending(next);
  }, [deliver, liveTail, liveQuestion, answerQuestion]);
  useEffect(() => {
    if (!sending || !pickerAsks(liveQuestion, liveTail, sending.asked)) return;
    // Codex lists the rows as asked, then its own `Other`.
    const option = liveQuestion?.options[sending.row];
    setSending(null);
    if (option) answerQuestion(option);
  }, [sending, liveTail, liveQuestion, answerQuestion]);
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
