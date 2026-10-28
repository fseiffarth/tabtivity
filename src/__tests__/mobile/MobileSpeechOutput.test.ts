import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as speech from "../../../mobile-web/src/speechOutput";
import { speechOutputSupported } from "../../../mobile-web/src/speechOutput";
import { BRAND, storageKey } from "../../lib/brand";

class FakeUtterance {
  lang = "";
  rate = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

let spoken: FakeUtterance[];
let cancels: number;
const said = () => spoken.map((utterance) => utterance.text);
const last = () => spoken[spoken.length - 1];
/** The utterance being said ends. */
const end = () => last().onend?.();
const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0));

const A1 = { id: "a1", agent: "Claude", text: "# Plan\n\nFirst we look. Then we fix.\n\n# Result\n\nIt works.\n\n```ts\nx();\ny();\n```" };
const A2 = { id: "a2", agent: "Claude", text: "Second answer." };
const answer = (n: number) => ({ id: `a${n}`, agent: "Claude", text: `Answer ${n}.` });
const feed = (answers: { id: string; agent: string; text: string }[]) =>
  speech.feedReading("tab", answers.map((one) => one.id), answers, "en-US");

/** Says every chunk to the end, returning what was said from here on. */
function sayAll(): string[] {
  const from = spoken.length - 1;
  for (let guard = 0; guard < 50 && speech.currentSpeechId() !== null; guard += 1) end();
  return said().slice(from);
}

describe(`${BRAND.display} Mobile read-aloud`, () => {
  beforeEach(() => {
    localStorage.clear();
    spoken = [];
    cancels = 0;
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    vi.stubGlobal("speechSynthesis", { speak: (utterance: FakeUtterance) => { spoken.push(utterance); }, cancel: () => { cancels += 1; } });
    speech.forgetReadings();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is absent where the browser cannot speak", () => {
    expect(speechOutputSupported({} as Window)).toBe(false);
    expect(speechOutputSupported({ speechSynthesis: {}, SpeechSynthesisUtterance: class {} } as unknown as Window)).toBe(true);
  });

  it("queues plain text behind what is being said", () => {
    speech.speak("q1", "One.", "en-US");
    speech.speak("q2", "Two.", "en-US");
    expect(said()).toEqual(["One."]);
    expect(speech.currentSpeechId()).toBe("q1");
    end();
    expect(said()).toEqual(["One.", "Two."]);
    end();
    expect(speech.currentSpeechId()).toBeNull();
  });

  it("takes a tab's first feed as history and names what arrives after", () => {
    expect(feed([A1])).toBeNull();
    expect(feed([A1, A2])).toEqual(["a2"]);
    expect(feed([A1, A2])).toEqual([]);
  });

  it("reads an answer through the reading model: code by its length, never its text", () => {
    feed([A1]);
    expect(speech.readAnswers("tab", "a1")).toBe(true);
    expect(speech.currentSpeechId()).toBe("a1");
    const all = sayAll();
    expect(all).toEqual(["Plan", "First we look. Then we fix.", "Result", "It works.", "code block, 2 lines"]);
    expect(all.join(" ")).not.toContain("x();");
    expect(speech.currentSpeechId()).toBeNull();
  });

  it("goes on into an answer that arrives while reading, without starting over", () => {
    feed([A1]);
    speech.readAnswers("tab", "a1");
    expect(feed([A1, A2])).toEqual(["a2"]);
    expect(speech.readAnswers("tab", "a2")).toBe(true);
    expect(said()).toEqual(["Plan"]);
    const all = sayAll();
    expect(all.filter((text) => text === "Second answer.")).toHaveLength(1);
    expect(all[all.length - 1]).toBe("Second answer.");
  });

  it("jumps to the next section, and the utterance it cut off starts nothing", () => {
    feed([A1]);
    speech.readAnswers("tab", "a1");
    const cut = last();
    expect(speech.readNext()).toBe(true);
    expect(cancels).toBeGreaterThan(0);
    expect(said()).toEqual(["Plan", "Result"]);
    cut.onend?.();
    expect(said()).toEqual(["Plan", "Result"]);
    // "next" past the last section ends the reading.
    expect(speech.readNext()).toBe(false);
    expect(speech.currentSpeechId()).toBeNull();
  });

  it("goes back, repeats, and says where it is before going on", () => {
    feed([A1]);
    speech.readAnswers("tab", "a1");
    end();
    expect(last().text).toBe("First we look. Then we fix.");
    speech.readBack();
    expect(last().text).toBe("Plan");
    speech.readRepeat();
    expect(last().text).toBe("Plan");
    expect(speech.sayWhere()).toBe(true);
    expect(last().text).toBe("answer 1 of 1, section 1 of 2");
    end();
    // The chunk the line cut off, again.
    expect(last().text).toBe("Plan");
  });

  it("keeps the tab's read position after a stop", () => {
    feed([A1]);
    speech.readAnswers("tab", "a1");
    end();
    speech.stopSpeaking();
    expect(speech.currentSpeechId()).toBeNull();
    expect(speech.hasReadPosition("tab")).toBe(true);
    expect(speech.readRepeat("tab")).toBe(true);
    expect(last().text).toBe("First we look. Then we fix.");
    expect(speech.readingNow()).toEqual({ tab: "tab", agent: "Claude", position: expect.objectContaining({ id: "a1", section: 1, chunk: 2 }) });
  });

  it("never reads on into an answer skipped while it was still being written", () => {
    feed([A1]);
    speech.readAnswers("tab", "a1");
    expect(speech.readNextAnswer()).toBe(false);
    expect(speech.currentSpeechId()).toBeNull();
    const grown = { ...A1, text: `${A1.text}\n\nMore words.` };
    expect(feed([grown])).toEqual([]);
    expect(spoken.some((utterance) => utterance.text === "More words.")).toBe(false);
    // The next answer is read from its start.
    expect(feed([grown, A2])).toEqual(["a2"]);
    speech.readAnswers("tab", "a2");
    expect(last().text).toBe("Second answer.");
  });

  it("reads a message from its menu on the tab's cursor, anything else on its own", () => {
    feed([A1, A2]);
    speech.readMessage("a1", A1.text, "en-US");
    expect(last().text).toBe("Plan");
    expect(speech.currentSpeechId()).toBe("a1");
    // The spoken moves go on from it.
    speech.readNextAnswer();
    expect(last().text).toBe("Second answer.");
    speech.readMessage("p1", "add a **clear** button", "en-US");
    expect(last().text).toBe("add a clear button");
    expect(speech.currentSpeechId()).toBe("p1");
    end();
    expect(speech.currentSpeechId()).toBeNull();
  });

  it("reads one message only, then the answer that arrived meanwhile", () => {
    feed([A1, A2]);
    speech.readMessage("a1", A1.text, "en-US");
    const three = answer(3);
    expect(feed([A1, A2, three])).toEqual(["a3"]);
    expect(speech.readAnswers("tab", "a3")).toBe(true);
    const all = sayAll();
    expect(all).not.toContain("Second answer.");
    expect(all[all.length - 1]).toBe("Answer 3.");
  });

  it("reads briefly once the setting says so, and persists it", () => {
    speech.setReadBrief(true);
    expect(localStorage.getItem(storageKey("mobile.voiceBrief"))).toBe("1");
    expect(speech.readBrief()).toBe(true);
    const long = {
      id: "long", agent: "Claude",
      text: "# Plan\n\nFirst we look at the composer and the way it holds a draft. Then we fix the button. Then we test it on the phone.\n\n# Result\n\nIt works on every screen we tried. The draft survives a reload. The button is gone when the draft is empty.",
    };
    feed([long]);
    speech.readAnswers("tab", "long");
    expect(last().text).toMatch(/^Claude answered, about \d+ lines$/);
    end();
    expect(last().text).toBe("Plan");
    end();
    expect(last().text).toBe("First we look at the composer and the way it holds a draft.");
  });

  it("steps the rate, persists it, and says the current chunk again at it", () => {
    feed([A1]);
    speech.readAnswers("tab", "a1");
    expect(speech.stepRate(1)).toBe(1.15);
    expect(localStorage.getItem(storageKey("mobile.voiceRate"))).toBe("1.15");
    expect(said()).toEqual(["Plan", "Plan"]);
    expect(last().rate).toBe(1.15);
    for (let i = 0; i < 10; i += 1) speech.stepRate(1);
    expect(speech.readingRate()).toBe(2);
    for (let i = 0; i < 10; i += 1) speech.stepRate(-1);
    expect(speech.readingRate()).toBe(0.7);
    speech.forgetReadings();
    expect(speech.readingRate()).toBe(0.7);
  });

  it("holds a turn's answers, then reads the last few of them", () => {
    feed([A1]);
    speech.holdReadingForTurn("tab", true);
    expect(speech.readingHeld("tab")).toBe(true);
    const turn = [A1, answer(2), answer(3), answer(4), answer(5)];
    expect(feed(turn)).toEqual(["a2", "a3", "a4", "a5"]);
    expect(speech.readTurn("tab", "a1")).toBe(true);
    expect(sayAll()).toEqual(["Answer 3.", "Answer 4.", "Answer 5."]);
    expect(speech.readTurn("tab", "a5")).toBe(false);
    speech.holdReadingForTurn("tab", false);
    expect(speech.readingHeld("tab")).toBe(false);
  });

  it("waits on the listening gap at each section's end", async () => {
    let open: () => void = () => {};
    const hook = vi.fn(() => new Promise<void>((resolve) => { open = resolve; }));
    const remove = speech.onSectionEnd(hook);
    feed([A1]);
    speech.readAnswers("tab", "a1");
    end();
    expect(hook).not.toHaveBeenCalled();
    end();
    expect(hook).toHaveBeenCalledWith({ tab: "tab", position: expect.objectContaining({ section: 1, chunk: 2 }), sectionEnd: true });
    await flush();
    expect(last().text).toBe("First we look. Then we fix.");
    open();
    await flush();
    expect(last().text).toBe("Result");

    // A command heard in the gap replaces the step it was waiting to take.
    end();
    end();
    end();
    expect(hook).toHaveBeenCalledTimes(2);
    speech.readRepeat();
    open();
    await flush();
    expect(said().slice(-2)).toEqual(["code block, 2 lines", "code block, 2 lines"]);
    remove();
  });

  it("pauses and resumes on the chunk it cut off", () => {
    feed([A1]);
    speech.readAnswers("tab", "a1");
    expect(speech.pauseReading()).toBe(true);
    expect(speech.readingPaused()).toBe(true);
    expect(speech.currentSpeechId()).toBeNull();
    expect(speech.resumeReading()).toBe(true);
    expect(said()).toEqual(["Plan", "Plan"]);
    expect(speech.currentSpeechId()).toBe("a1");
  });

  it("runs the reading commands as the matcher hears them", () => {
    expect(speech.runReadingCommand("repeat", "tab")).toBe(false);
    feed([A1]);
    speech.readAnswers("tab", "a1");
    speech.stopSpeaking();
    // A rate step with nothing being said is heard on the current chunk.
    expect(speech.runReadingCommand("slower", "tab")).toBe(true);
    expect(last()).toMatchObject({ text: "Plan", rate: 0.85 });
    expect(speech.runReadingCommand("next", "tab")).toBe(true);
    expect(last().text).toBe("Result");
    expect(speech.runReadingCommand("readCode", "tab")).toBe(true);
    expect(last().text).toBe("x();\ny();");
    expect(speech.runReadingCommand("stop", "tab")).toBe(true);
    expect(speech.currentSpeechId()).toBeNull();
  });
});
