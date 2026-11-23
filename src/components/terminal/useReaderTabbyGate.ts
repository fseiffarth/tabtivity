import { useRef, useState, type MutableRefObject } from "react";
import { GATE_WINDOW_MS } from "../../../shared/voice";
import { playChime } from "../../lib/voice/chime";

/** The line the gate shows on the voice strip: the cue after a send, or the
 * wait for the prompt after the start word said alone. */
export type ReaderTabbyLine = "cue" | "listening";

export interface ReaderTabbyGate {
  /** Whether the gate is on; read in the session's handlers. */
  on: MutableRefObject<boolean>;
  line: ReaderTabbyLine | null;
  /** A prompt is being dictated through the gate (the start word was said, or
   * its window is open): read-aloud holds while it is, so the voice never
   * mutes the mic in the middle of it. */
  drafting: boolean;
  /** The next utterance counts as the prompt without the start word. */
  windowOpen(): boolean;
  /** A hands-free send went out: the gate is on, the chime plays, the cue shows. */
  arm(): void;
  /** The mic was started for a landing: the gate on or off, no chime. */
  set(on: boolean): void;
  /** The start word was said alone: the chime plays and the next utterance
   * (for `GATE_WINDOW_MS`) is the prompt. */
  listen(): void;
  /** An utterance went through the gate: it is a draft under way now. */
  kept(): void;
  /** The draft is empty again (scratched): no draft under way, unless the
   * start word's window is still open. */
  idle(): void;
  /** A click on the mic, typing, hands-free's reopen after a read, the
   * session's end: the gate is off. */
  clear(): void;
}

/**
 * The Tabby gate in the desktop Chat (docs/desktop_tabby_navigate_plan.md
 * step 6; the phone's is `useTabbyGate.ts`, its rules handoff Flagged 1–2):
 * with Hands-free on, the mic keeps listening through the agent's turn after
 * a send, and only an utterance that starts with the start word counts — or
 * any, while a draft is under way or for `GATE_WINDOW_MS` after "Tabby"
 * said alone. This holds the state; `useReaderVoice` applies it to each final.
 */
export function useReaderTabbyGate(): ReaderTabbyGate {
  const on = useRef(false);
  const until = useRef(0);
  const timer = useRef(0);
  const [line, setLine] = useState<ReaderTabbyLine | null>(null);
  const [drafting, setDrafting] = useState(false);
  const closeWindow = () => {
    window.clearTimeout(timer.current);
    until.current = 0;
  };
  return {
    on, line, drafting,
    windowOpen: () => on.current && until.current > Date.now(),
    arm() {
      closeWindow();
      on.current = true;
      setDrafting(false);
      setLine("cue");
      playChime();
    },
    set(next) {
      closeWindow();
      on.current = next;
      setDrafting(false);
      setLine(next ? "cue" : null);
    },
    listen() {
      if (!on.current) return;
      closeWindow();
      until.current = Date.now() + GATE_WINDOW_MS;
      setLine("listening");
      setDrafting(true);
      playChime();
      timer.current = window.setTimeout(() => {
        until.current = 0;
        setLine(on.current ? "cue" : null);
        setDrafting(false);
      }, GATE_WINDOW_MS);
    },
    kept() {
      if (!on.current) return;
      closeWindow();
      setLine("cue");
      setDrafting(true);
    },
    idle() {
      if (until.current <= Date.now()) setDrafting(false);
    },
    clear() {
      closeWindow();
      on.current = false;
      setDrafting(false);
      setLine(null);
    },
  };
}
