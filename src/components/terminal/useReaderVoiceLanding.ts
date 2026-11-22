import { useEffect, useRef, useState } from "react";
import { spokenText } from "../../../shared/voice";
import { landingFromTurns, type LandingTurn } from "../../../shared/voiceNav";
import type { NavLine, NavSpeechWait } from "../../../shared/voiceNavMode";
import { loadDict, translate, type Language } from "../../lib/i18n";
import { takeDesktopLanding, watchDesktopLanding, type DesktopLanding } from "../../lib/voice/desktopNav";
import { voiceSpeakStop } from "../../lib/voice/desktopVoice";
import { speakThenWait, type ReaderSpeech } from "./useReaderVoiceNav";

/** The conversation is waited for this long; then only where it landed is said. */
export const DESKTOP_LANDING_TRANSCRIPT_WAIT_MS = 6_000;
/** A mic the landing wants waits this long for the box to be ready (the CLI
 * still starting, a project just restored). */
export const DESKTOP_LANDING_READY_WAIT_MS = 30_000;
/** More answers than this after the prompt: only the last is said (read-aloud's rule). */
const MAX_ANSWERS_SAID = 3;

/**
 * The other half of a spoken jump in the desktop Chat
 * (docs/desktop_tabby_navigate_plan.md step 7): the Chat that comes into view
 * on the tab a jump went to takes the note it left (`desktopNav.ts`). A
 * Hands-free note waits for the conversation's first read, says "You asked:
 * …" and the answers after that prompt, tells read-aloud those are read
 * (`markRead`, so the turn's end does not read them twice), then starts the
 * mic with the Tabby gate on — off when the box holds a draft. A plain-mic
 * note starts the mic at once, ungated, and says nothing. Either start is the
 * mic button's own, so a missing speech model behaves as a click does; a box
 * not ready yet (its CLI starting) is waited for a while first. A Chat
 * already on screen takes a note the moment it is left. Returns the line
 * shown while it reads.
 */
export function useReaderVoiceLanding({ ptyId, visible, ready, transcriptRead, turns, startMic, hasDraft, markRead, speech, lang }: {
  ptyId: string;
  /** The Chat is on screen. */
  visible: boolean;
  /** The mic can start (the box takes input). */
  ready: boolean;
  /** The conversation has been read once (it may be empty). */
  transcriptRead: boolean;
  turns: readonly LandingTurn[];
  startMic: (gated: boolean) => void;
  hasDraft: () => boolean;
  markRead: (keys: readonly string[]) => void;
  speech: () => ReaderSpeech | null;
  lang: () => Language;
}): NavLine | null {
  const [landing, setLanding] = useState<DesktopLanding | null>(null);
  /** The note in `landing` was acted on. */
  const begun = useRef(false);
  useEffect(() => {
    if (!visible) return;
    const take = () => {
      const note = takeDesktopLanding(ptyId);
      if (!note) return;
      begun.current = false;
      setLanding(note);
    };
    take();
    return watchDesktopLanding(take);
  }, [visible, ptyId]);

  const [waitedOut, setWaitedOut] = useState(false);
  useEffect(() => {
    setWaitedOut(false);
    if (!landing?.handsFree) return;
    const timer = window.setTimeout(() => setWaitedOut(true), DESKTOP_LANDING_TRANSCRIPT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [landing]);

  const [line, setLine] = useState<NavLine | null>(null);
  const wait = useRef<NavSpeechWait | null>(null);
  /** Bumped when the reading is dropped (the Chat hidden or gone). */
  const epoch = useRef(0);
  const live = useRef({ turns, startMic, hasDraft, markRead, speech, lang });
  live.current = { turns, startMic, hasDraft, markRead, speech, lang };

  /** The mic the landing asked for, once the box is ready: gated or not. */
  const [wanted, setWanted] = useState<{ gated: boolean } | null>(null);
  useEffect(() => {
    if (!wanted) return;
    if (ready && visible) {
      setWanted(null);
      live.current.startMic(wanted.gated && !live.current.hasDraft());
      return;
    }
    const timer = window.setTimeout(() => setWanted(null), DESKTOP_LANDING_READY_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [wanted, ready, visible]);
  const drop = () => {
    epoch.current += 1;
    const speaking = wait.current;
    wait.current = null;
    speaking?.cancel();
    setLine(null);
    return speaking !== null;
  };
  // The Chat going away drops a reading in flight.
  useEffect(() => () => { drop(); }, []);

  useEffect(() => {
    if (!landing || begun.current) return;
    if (!landing.handsFree) {
      begun.current = true;
      setWanted({ gated: false });
      return;
    }
    if (!transcriptRead && !waitedOut) return;
    begun.current = true;
    const mine = epoch.current;
    const stale = () => epoch.current !== mine;
    const openMic = () => {
      if (stale()) return;
      wait.current = null;
      setLine(null);
      setWanted({ gated: true });
    };
    const language = live.current.lang();
    void loadDict(language).catch(() => false).then(() => {
      if (stale()) return;
      const tr = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate(language, key, params);
      const found = transcriptRead ? landingFromTurns(live.current.turns) : null;
      const lines: string[] = [];
      if (!found) lines.push(landing.where);
      else {
        lines.push(tr("voice.nav.youAsked", { text: found.text }));
        const code = tr("terminal.reader.voice.code");
        const said = found.answers.length > MAX_ANSWERS_SAID ? found.answers.slice(-1) : found.answers;
        for (const answer of said) lines.push(spokenText(answer.text, code));
        if (found.answers.length === 0) lines.push(tr("voice.nav.noAnswerYet"));
        live.current.markRead(found.answers.map((answer) => answer.key));
      }
      const how = live.current.speech();
      if (!how) {
        openMic();
        return;
      }
      // A click on the line: the voice stops, the mic opens now.
      const skip = () => {
        if (stale()) return;
        wait.current?.cancel();
        void voiceSpeakStop().catch(() => {});
        openMic();
      };
      setLine({ text: lines[0], run: skip, untested: "terminal.reader.voice.navigate" });
      const sayFrom = (index: number) => {
        if (stale()) return;
        if (index >= lines.length) {
          openMic();
          return;
        }
        wait.current = speakThenWait(`${ptyId}#landing:${index}`, lines[index], how, () => sayFrom(index + 1));
      };
      sayFrom(0);
    });
  // `turns` is read when the reading starts: a later read of the same session is not a new landing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landing, transcriptRead, waitedOut]);

  // The Chat went out of view: what it was saying stops with it.
  useEffect(() => {
    if (!visible && drop()) void voiceSpeakStop().catch(() => {});
  }, [visible]);

  return line;
}
