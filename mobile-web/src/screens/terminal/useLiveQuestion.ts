// The phone terminal's live question: the dialog the session is waiting on,
// as the Focus chat lists it, and the taps that answer it.
import { useEffect, useMemo, useState } from "react";
import { type ReadableLine } from "../../terminal/readableScreen";
import {
  answerRowKeys, freeTextWrites, questionTabKeys, selectSignature, type SelectOption,
  type SelectPrompt,
} from "../../terminal/selectPrompt";
import { NO_QUESTION_PARTS, questionParts, type QuestionParts } from "../../terminal/questionParts";
import { opensAgentMessage } from "../../terminal/chatTurns";
import { MODEL_PICKER_WAIT } from "./terminalShared";

/** How long the dialog an answer brought up takes no tap: a CLI asks its next
 * question at once and in the same place (Codex's "Hooks need review" under
 * its folder question), and a second tap meant for the answered row took the
 * new dialog's row unseen. */
const NEXT_DIALOG_HOLD = 600;

/** The question the session is waiting on, as the chat lists it, and the taps that answer it. */
export function useLiveQuestion({
  clearPending, deliver, agentLabel, liveTail, liveQuestion,
}: {
  clearPending: () => void;
  deliver: (writes: string[], prompt?: number) => boolean;
  agentLabel: string;
  liveTail: ReadableLine[];
  liveQuestion: SelectPrompt | null;
}) {
  /** The dialog's own question — the block right above its rows, which the
   * list below shows as its heading — and the screen it was drawn onto, which
   * stays as the session drew it. Blank rows at either seam are the dialog's
   * own gutter, not a paragraph of anybody's.
   *
   * Between the two Claude Code draws a tab row over a question an agent asks
   * (`readQuestionTabs`); it is the question's label, so it is lifted off and
   * the list shows it as chips. Such a question and the agent's prose above it
   * are rejoined into paragraphs (`joinProseWraps`) — any other dialog's
   * screen, a diff or a command, stays as drawn. */
  const { ask: questionAsk, context: questionContext, tabs: questionTabs, tabFocus: questionTabFocus, tabSubmit: questionTabSubmit, tabKeys: questionStepKeys } = useMemo(
    (): QuestionParts => (liveQuestion ? questionParts(liveTail, liveQuestion) : NO_QUESTION_PARTS),
    [liveQuestion, liveTail],
  );
  /** An agent's own question (a tab row over it) shows the agent's message
   * above it only when that message is read from its first row. Anything else
   * there — a thinking preview's last rows, a half-erased row of the answer
   * before, a message whose top `CONTEXT_LINES` cut off — reached the chat as
   * fragments cut mid-sentence; the conversation behind the card has the turn. */
  const questionContextShown = questionContext.length > 0
    && (questionTabs.length === 0 || opensAgentMessage(questionContext[0], agentLabel));
  /** What the list on screen *is*, as a string: a stable dep for the effects
   * below, which must not restart on every repaint of the same question. Two
   * questions of one dialog can offer the same rows (two yes/no questions):
   * the step they are on tells them apart. */
  const questionSignature = !liveQuestion ? ""
    : questionTabs.length === 0 ? selectSignature(liveQuestion)
    : [selectSignature(liveQuestion), ...questionTabs.map((tab) => `${tab.answered ? "✓" : "☐"}${tab.label}`), `@${questionTabFocus ?? ""}`, ...questionAsk.map((line) => line.text)].join("\n");
  /** The question a tap just answered, while the session has not redrawn yet:
   * its rows stay listed, but nothing can be tapped twice. */
  const [questionSent, setQuestionSent] = useState<{ signature: string; number: number } | null>(null);
  const sentSignature = questionSent?.signature ?? "";
  /** The dialog drawn in place of an answered one, while it is held
   * (`NEXT_DIALOG_HOLD`). */
  const [heldQuestion, setHeldQuestion] = useState("");
  useEffect(() => {
    if (!heldQuestion) return;
    const timer = window.setTimeout(() => setHeldQuestion(""), NEXT_DIALOG_HOLD);
    return () => window.clearTimeout(timer);
  }, [heldQuestion]);
  const questionHeld = !!questionSent || (!!heldQuestion && heldQuestion === questionSignature);
  useEffect(() => {
    if (!sentSignature) return;
    // Redrawn as something else — answered, or moved on: the list is live again.
    if (questionSignature !== sentSignature) {
      setQuestionSent(null);
      if (questionSignature) setHeldQuestion(questionSignature);
      return;
    }
    // Still the same question after the keys had time to land: the answer did
    // not arrive. Give the list back rather than leave a dead block on screen.
    const stuck = window.setTimeout(() => setQuestionSent(null), MODEL_PICKER_WAIT);
    return () => window.clearTimeout(stuck);
  }, [sentSignature, questionSignature]);
  /** Answers the question on screen with the row tapped — the same arrow keys
   * and Enter the on-screen key row sends, so a tapped row lands exactly as a
   * walked one. Nothing here decides what the options are. */
  const answerQuestion = (option: SelectOption) => {
    if (!liveQuestion || questionHeld) return;
    clearPending();
    if (!deliver(answerRowKeys(liveQuestion, option))) return;
    setQuestionSent({ signature: questionSignature, number: option.number });
  };
  /** Walks a several-question dialog — Claude Code's ←/→, Codex's
   * PageUp/PageDown — so an answer already given can be changed before it is
   * sent. No row is pending, but none can be tapped until the session redraws. */
  const stepQuestion = (from: number, to: number) => {
    const keys = questionTabKeys(from, to, questionStepKeys);
    if (!liveQuestion || questionHeld || keys.length === 0) return;
    clearPending();
    if (!deliver(keys)) return;
    setQuestionSent({ signature: questionSignature, number: -1 });
  };
  /** Answers the question's free-text row (`freeTextRow`) with what was typed
   * under it: the highlight walked there, the words, and Enter where Enter
   * sends them (`freeTextWrites`). */
  const answerQuestionText = (option: SelectOption, text: string) => {
    if (!liveQuestion || questionHeld) return;
    const writes = freeTextWrites(liveQuestion.current, option, text);
    if (writes.length === 0) return;
    clearPending();
    if (!deliver(writes)) return;
    setQuestionSent({ signature: questionSignature, number: option.number });
  };
  return { questionAsk, questionContext, questionTabs, questionTabFocus, questionTabSubmit, questionContextShown, questionSignature, questionHeld, questionSent, sentSignature, answerQuestion, stepQuestion, answerQuestionText };
}
