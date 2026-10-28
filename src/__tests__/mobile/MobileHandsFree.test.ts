import { describe, expect, it } from "vitest";
import { handsFreeTurnOver, questionSpeech, voicePick } from "../../../mobile-web/src/handsFree";
import type { SelectPrompt } from "../../../mobile-web/src/terminal/selectPrompt";
import { UNNUMBERED } from "../../../mobile-web/src/terminal/selectPrompt";

const prompt = (labels: string[], extra: Partial<SelectPrompt> = {}): SelectPrompt => ({
  current: 0,
  start: 0,
  question: 0,
  context: 0,
  options: labels.map((label, index) => ({ index, number: index + 1, label })),
  ...extra,
} as SelectPrompt);

describe("the phone's hands-free loop", () => {
  it("picks a question's row by the number it printed", () => {
    const yesNo = prompt(["Yes", "Yes, and don't ask again", "No, and tell Claude what to do"]);
    expect(voicePick("two", yesNo)?.label).toBe("Yes, and don't ask again");
    expect(voicePick("Option 1.", yesNo)?.label).toBe("Yes");
    expect(voicePick("die Dritte", yesNo)?.label).toBe("No, and tell Claude what to do");
    expect(voicePick("four", yesNo)).toBeNull();
    expect(voicePick("I think two is fine", yesNo)).toBeNull();
  });

  it("never picks a free-text row or an unnumbered Submit row", () => {
    const withFree = prompt(["Red", "Blue", "Type something."]);
    expect(voicePick("three", withFree)).toBeNull();
    expect(voicePick("two", withFree)?.label).toBe("Blue");
    const submit: SelectPrompt = {
      ...prompt(["A", "B"]),
      options: [{ index: 0, number: 1, label: "A" }, { index: 1, number: 2, label: "B" }, { index: 2, number: UNNUMBERED, label: "Submit" }],
    };
    expect(voicePick("three", submit)).toBeNull();
  });

  it("reads a question out with its rows by number", () => {
    const yesNo = prompt(["Yes", "No", "Type something."]);
    expect(questionSpeech(["Do you want to make this edit", "to app.ts?"], yesNo))
      .toBe("Do you want to make this edit to app.ts? 1: Yes. 2: No.");
    expect(questionSpeech([], prompt(["Opus"], { title: "Select Model" }))).toBe("Select Model 1: Opus.");
  });

  it("opens the mic only once the turn is over", () => {
    const base = { busy: false, sawWork: false, question: false, answerAtSend: "a1", answerNow: "a1" };
    // Nothing seen yet: the agent may not have started.
    expect(handsFreeTurnOver(base)).toBe(false);
    expect(handsFreeTurnOver({ ...base, busy: true, sawWork: true })).toBe(false);
    expect(handsFreeTurnOver({ ...base, sawWork: true })).toBe(true);
    // Too quick for its busy row: a new answer while idle ends it.
    expect(handsFreeTurnOver({ ...base, answerNow: "a2" })).toBe(true);
    // A mid-turn answer while still busy does not.
    expect(handsFreeTurnOver({ ...base, busy: true, answerNow: "a2" })).toBe(false);
    // A question waits on the user.
    expect(handsFreeTurnOver({ ...base, busy: true, question: true })).toBe(true);
  });
});
