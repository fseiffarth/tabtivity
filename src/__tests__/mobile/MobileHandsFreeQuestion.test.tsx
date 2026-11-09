/**
 * Hands-free reads a question the agent waits on out loud (read-aloud on). The
 * mic would hear it, so it closes for the reading; while spoken navigation is
 * open the mode owns the mic and the voice, so the question waits for it.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHandsFree } from "../../../mobile-web/src/screens/terminal/useHandsFree";
import { forgetReadings } from "../../../mobile-web/src/speechOutput";
import type { SelectPrompt } from "../../../mobile-web/src/terminal/selectPrompt";
import type { TabRow } from "../../../mobile-web/src/api";
import { storageKey } from "../../lib/brand";

class FakeUtterance {
  lang = "";
  rate = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

const TAB: TabRow = { id: "tab-1", label: "Claude", kind: "agent", agent_label: "Claude Code", available: true, viewer_busy: false };
/** A question a voice may answer: it carries the free-text row. */
const QUESTION = {
  current: 0, start: 0, question: 0, context: 0,
  options: ["Fix only", "Push everything", "Type something."].map((label, index) => ({ index, number: index + 1, label })),
} as SelectPrompt;

describe("hands-free reading a question out", () => {
  let spoken: string[];

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(storageKey("mobile.focusHandsFree"), "1");
    spoken = [];
    forgetReadings();
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    vi.stubGlobal("speechSynthesis", {
      speak: (utterance: FakeUtterance) => { spoken.push(utterance.text); },
      cancel: () => {},
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setup(navOpen: boolean, preparingVoice = false) {
    const recognition = { current: { stop: vi.fn(), abort: vi.fn() } };
    const endDictation = vi.fn(() => { recognition.current = undefined as never; });
    const props = (open: boolean, preparing = preparingVoice) => ({
      tab: TAB,
      t: ((key: string) => key) as never,
      sendGuard: { current: undefined },
      voiceOpen: { current: false },
      recognition: recognition as never,
      draftRef: { current: "" },
      submitDraftRef: { current: () => false },
      startVoiceRef: { current: async () => {} },
      endDictation,
      tabbyGate: { clear: vi.fn(), set: vi.fn(), on: { current: false } } as never,
      navOpen: open,
      connected: true,
      listening: true,
      preparingVoice: preparing,
      readAloud: true,
      liveBusy: false,
      liveQuestion: QUESTION,
      questionHeld: false,
      questionSignature: "q1",
      questionAsk: [{ text: "How should I land the fix?" }] as never,
      answerQuestion: vi.fn(),
      transcript: null,
    });
    const view = renderHook(({ open, preparing }: { open: boolean; preparing: boolean }) => useHandsFree(props(open, preparing)), { initialProps: { open: navOpen, preparing: preparingVoice } });
    return { view, endDictation, recognition };
  }

  it("reads a question and closes the mic for it", () => {
    const { endDictation } = setup(false);
    expect(endDictation).toHaveBeenCalledTimes(1);
    expect(spoken.join(" ")).toContain("How should I land the fix?");
  });

  it("waits for spoken navigation: no voice over it, the mic left to the mode", () => {
    const { view, endDictation } = setup(true);
    expect(spoken).toEqual([]);
    expect(endDictation).not.toHaveBeenCalled();
    // The mode ends: the question is read then, once.
    act(() => view.rerender({ open: false, preparing: false }));
    expect(endDictation).toHaveBeenCalledTimes(1);
    expect(spoken.join(" ")).toContain("How should I land the fix?");
    act(() => view.rerender({ open: true, preparing: false }));
    act(() => view.rerender({ open: false, preparing: false }));
    expect(spoken.filter((text) => text.includes("How should I land the fix?"))).toHaveLength(1);
  });

  it("waits for a mic still being prepared, which would open under the reading", () => {
    const { view, endDictation } = setup(false, true);
    expect(spoken).toEqual([]);
    act(() => view.rerender({ open: false, preparing: false }));
    expect(endDictation).toHaveBeenCalledTimes(1);
    expect(spoken.join(" ")).toContain("How should I land the fix?");
  });
});
