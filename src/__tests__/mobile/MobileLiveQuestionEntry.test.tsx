/**
 * The phone's live question through the transcript's waiting entry: the
 * merged card answers with the keys the screen's reading computes, and a card
 * drawn from the entry alone sends nothing.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TranscriptEntry } from "../../../mobile-web/src/api";
import { useLiveQuestion } from "../../../mobile-web/src/screens/terminal/useLiveQuestion";
import { mergeAskedQuestion, type LiveDialog } from "../../../mobile-web/src/terminal/askedQuestion";
import { readableScreen, type ReadableBufferLike } from "../../../mobile-web/src/terminal/readableScreen";
import { isLiveEcho } from "../../../mobile-web/src/terminal/chatTurns";
import { questionParts } from "../../../mobile-web/src/terminal/questionParts";
import { readLiveQuestion } from "../../../mobile-web/src/terminal/liveDialog";
import { inputFrameStart } from "../../../mobile-web/src/terminal/statusLine";

function plainBuffer(rows: string[]): ReadableBufferLike {
  return { length: rows.length, getLine: (row) => (rows[row] === undefined ? undefined : { translateToString: () => rows[row] }) };
}

const ENTRY: TranscriptEntry = {
  kind: "answer", text: "Which colours?", at: "2026-11-18T09:19:13.591Z", blocking: true,
  questions: [{ header: "Colours", question: "Which colours should the probe use?", multiSelect: true, options: [{ label: "Red", description: "warm" }, { label: "Blue" }] }],
};
const SCREEN = [
  "❯ ask me", "", "←  ☐ Colours  →", "Which colours should the probe use?",
  "❯ 1. [ ] Red", "       warm", "  2. [ ] Blue", "  3. [ ] Type something", "     Submit", "", "  4. Chat about this", "",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
];

function phoneReads(rows: string[]) {
  const { lines } = readableScreen(plainBuffer(rows), 300);
  const screen = lines.slice(0, inputFrameStart(lines, "Claude"));
  let start = 0;
  screen.forEach((line, index) => { if (isLiveEcho(line, "Claude")) start = index + 1; });
  const tail = screen.slice(start);
  return { tail, question: readLiveQuestion(tail, lines, "Claude", 76) };
}

function dialogOf(tail: ReturnType<typeof phoneReads>["tail"], question: NonNullable<ReturnType<typeof phoneReads>["question"]>): LiveDialog {
  const parts = questionParts(tail, question);
  return { question, ask: parts.ask.map((line) => line.text), context: parts.context.map((line) => line.text), tabs: parts.tabs, tabFocus: parts.tabFocus, tabSubmit: parts.tabSubmit, tabKeys: parts.tabKeys };
}

describe("the phone's live question over the waiting entry", () => {
  it("lists the entry's words and answers a tapped row with the screen's own keys", () => {
    const { tail, question } = phoneReads(SCREEN);
    expect(question).not.toBeNull();
    const card = mergeAskedQuestion(ENTRY, dialogOf(tail, question!));
    expect(card?.kind).toBe("merged");
    const deliver = vi.fn(() => true);
    const { result } = renderHook(() => useLiveQuestion({
      clearPending: vi.fn(), deliver, agentLabel: "Claude", liveTail: tail, liveQuestion: card!.question, askedCard: card,
    }));
    expect(result.current.questionAsk.map((line) => line.text)).toEqual(["Which colours should the probe use?"]);
    expect(result.current.questionTabs).toEqual([{ label: "Colours", answered: false }]);
    // The signature is the screen's: a tick (a glyph in its label) still counts as a redraw.
    expect(result.current.questionSignature).toContain("1. [ ] Red");
    act(() => result.current.answerQuestion(card!.question.options[1]));
    // Down once from the highlighted first row, then Enter, as the screen's reading computes.
    expect(deliver).toHaveBeenCalledWith(["\u001b[B", "\r"]);
  });

  it("sends nothing from a card drawn from the entry alone", () => {
    const card = mergeAskedQuestion(ENTRY, null, true)!;
    const deliver = vi.fn(() => true);
    const { result } = renderHook(() => useLiveQuestion({
      clearPending: vi.fn(), deliver, agentLabel: "Claude", liveTail: [], liveQuestion: card.question, askedCard: card,
    }));
    expect(result.current.questionAsk.map((line) => line.text)).toEqual(["Which colours should the probe use?"]);
    expect(result.current.questionTabs).toEqual([{ label: "Colours", answered: false }]);
    expect(result.current.questionSignature).toContain("entry:2026-11-18T09:19:13.591Z");
    act(() => result.current.answerQuestion(card.question.options[0]));
    act(() => result.current.stepQuestion(0, 1));
    act(() => result.current.answerQuestionText(card.question.options[0], "words"));
    expect(deliver).not.toHaveBeenCalled();
  });
});
