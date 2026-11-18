import { useMemo, useRef } from "react";
import type { TranscriptEntry } from "../../api";
import { entryCardAllowed, mergeAskedQuestion, type AskedCard } from "../../terminal/askedQuestion";
import type { ReadableLine } from "../../terminal/readableScreen";
import { questionParts } from "../../terminal/questionParts";
import type { SelectPrompt } from "../../terminal/selectPrompt";

/** What identifies a waiting entry across reads: the call has no id on the wire. */
const entryKey = (entry: TranscriptEntry): string => `${entry.at ?? ""}|${entry.text}`;

/**
 * The phone's card for the question Claude is blocked on (`mergeAskedQuestion`)
 * over the screen's reading of it.
 *
 * The entry alone (a read-only card) stands only for the moment before the
 * dialog is drawn. The phone reads the stored session a few seconds late (poll
 * and settle clocks), so a stale entry outlives the dialog it came from: once
 * answered, the screen shows a busy row over the input box — the same picture
 * as before the dialog. An entry whose dialog has been on this screen is
 * therefore spent: it never stands alone again.
 */
export function useAskedCard({ waitingAsk, screenQuestion, liveTail, liveScreen, agentLabel }: {
  waitingAsk: TranscriptEntry | null;
  screenQuestion: SelectPrompt | null;
  liveTail: ReadableLine[];
  liveScreen: ReadableLine[];
  agentLabel: string;
}): AskedCard | null {
  /** The entry (`entryKey`) a dialog was last on screen for. */
  const dialogSeen = useRef<string | null>(null);
  return useMemo(() => {
    if (!waitingAsk) return null;
    const key = entryKey(waitingAsk);
    if (screenQuestion) dialogSeen.current = key;
    const parts = screenQuestion ? questionParts(liveTail, screenQuestion) : null;
    return mergeAskedQuestion(
      waitingAsk,
      screenQuestion && parts ? { question: screenQuestion, ask: parts.ask.map((line) => line.text), context: parts.context.map((line) => line.text), tabs: parts.tabs, tabFocus: parts.tabFocus, tabSubmit: parts.tabSubmit, tabKeys: parts.tabKeys } : null,
      !screenQuestion && dialogSeen.current !== key && entryCardAllowed(liveScreen, agentLabel),
    );
  }, [waitingAsk, screenQuestion, liveTail, liveScreen, agentLabel]);
}
