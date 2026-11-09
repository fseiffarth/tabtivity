// The Tabby gate (docs/voice_nav_mode_plan.md decision 7), hands-free only: from
// a spoken send ("go on") the open mic dictates only an utterance that starts
// with the start word, and a chime plus a line tell the user they can go on.
// This holds the gate's state; `voiceInput.ts` applies it to the utterances
// (`stepUtterances`) and `useVoiceInput` feeds it.
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { playChime } from "../../../../src/lib/voice/chime";
import { GATE_WINDOW_MS } from "../../voiceInput";

/** The line the gate shows on the voice line: the cue after a send, or the
 * wait for the prompt after the start word said alone. */
export type TabbyLine = "cue" | "listening";

export interface TabbyGate {
  /** Whether the gate is on; read in the recognizer's handlers. */
  on: MutableRefObject<boolean>;
  /** What the voice line says for the gate, `null` when it is off. */
  line: TabbyLine | null;
  /** The next utterance counts as the prompt without the start word (the start
   * word was said alone just now). */
  windowOpen(): boolean;
  /** A spoken send went out: the gate is on, the chime plays, the cue shows. */
  arm(): void;
  /** The mic was started for a reason other than a tap (navigation, a landing):
   * the gate is on or off, with no cue. */
  set(on: boolean): void;
  /** The start word was said alone: the chime plays and the next utterance
   * (for `GATE_WINDOW_MS`) starts the draft. */
  listen(): void;
  /** An utterance took the window: back to the cue. */
  windowUsed(): void;
  /** A tap on the mic, typing, hands-free's own send or reopen, the end of the
   * mic: the gate is off. */
  clear(): void;
}

export function useTabbyGate(tabId: string): TabbyGate {
  const on = useRef(false);
  const until = useRef(0);
  const timer = useRef(0);
  const [line, setLine] = useState<TabbyLine | null>(null);
  const closeWindow = () => {
    window.clearTimeout(timer.current);
    until.current = 0;
  };
  const clear = () => {
    closeWindow();
    on.current = false;
    setLine(null);
  };
  const windowUsed = () => {
    if (until.current === 0) return;
    closeWindow();
    setLine(on.current ? "cue" : null);
  };
  const gate: TabbyGate = {
    on, line,
    windowOpen: () => on.current && until.current > Date.now(),
    arm() {
      closeWindow();
      on.current = true;
      setLine("cue");
      playChime();
    },
    set(next) {
      closeWindow();
      on.current = next;
      setLine(null);
    },
    listen() {
      if (!on.current) return;
      closeWindow();
      until.current = Date.now() + GATE_WINDOW_MS;
      setLine("listening");
      playChime();
      timer.current = window.setTimeout(() => {
        until.current = 0;
        setLine("cue");
      }, GATE_WINDOW_MS);
    },
    windowUsed,
    clear,
  };
  // The gate belongs to the tab it was armed in.
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    until.current = 0;
    on.current = false;
    setLine(null);
  }, [tabId]);
  return gate;
}
