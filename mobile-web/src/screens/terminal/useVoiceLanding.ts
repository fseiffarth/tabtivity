// The other half of a spoken jump (docs/voice_nav_mode_plan.md, decisions 5–6):
// the screen a jump opened takes the note the jump left (`voiceNav.ts`), says
// where the reader landed — their last prompt there, then the agent's answer to
// it, through the same reading cursor any answer is read with — and then opens
// the mic for dictation with the Tabby gate on.
// The screen's own read has to come first: the cursor only exists after the
// first feed of the stored session (`useReadAloud`), which is declared before
// this hook, so its effect has run when this one's does.
import { useEffect, useRef, useState } from "react";
import { loadDict, translate, type TranslationKey } from "../../../../src/lib/i18n";
import { type SessionTranscript, type TabRow } from "../../api";
import { speechLanguage, speechTag } from "../../speechLang";
import { currentSpeechId, readTurn, speak, stopSpeaking, subscribeSpeech } from "../../speechOutput";
import { landingRead, takeLanding, type Landing } from "../../voiceNav";
import { type StartVoiceOptions } from "./useVoiceInput";
import { NAV_TAIL_MS, type NavLine } from "./useVoiceNav";

/** The transcript is waited for this long; then the tab row's last prompt stands in. */
export const LANDING_TRANSCRIPT_WAIT_MS = 6_000;

type Phase = "waiting" | "speaking" | "done";

export function useVoiceLanding({
  tab, connected, handsFree, micOpen, transcript, sessionFocus, startVoiceRef,
}: {
  tab: TabRow;
  connected: boolean;
  /** Hands-free is on: a landing only exists there. */
  handsFree: boolean;
  /** The mic is already listening (a tap on it) or being prepared. */
  micOpen: () => boolean;
  transcript: SessionTranscript | null;
  /** Focus is reading the stored session. */
  sessionFocus: boolean;
  startVoiceRef: { current: (options?: StartVoiceOptions) => Promise<void> };
}): NavLine | null {
  const [landing, setLanding] = useState<Landing | null>(null);
  const taken = useRef(false);
  // The note is taken once, in an effect: a development remount runs it twice.
  useEffect(() => {
    if (taken.current) return;
    taken.current = true;
    setLanding(takeLanding(tab.id));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [waitedOut, setWaitedOut] = useState(false);
  useEffect(() => {
    if (!landing) return;
    const timer = window.setTimeout(() => setWaitedOut(true), LANDING_TRANSCRIPT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [landing]);
  const [phase, setPhase] = useState<Phase>("waiting");
  const [line, setLine] = useState<NavLine | null>(null);
  const begun = useRef(false);
  const gone = useRef(false);
  const skip = useRef<() => void>(() => {});
  useEffect(() => () => { gone.current = true; }, []);

  // Once connected and the stored session is in: what is said on arrival.
  useEffect(() => {
    if (!landing || phase !== "waiting" || begun.current) return;
    if (!handsFree) {
      setPhase("done");
      return;
    }
    if (!connected || !(!sessionFocus || transcript !== null || waitedOut)) return;
    begun.current = true;
    if (micOpen()) {
      setPhase("done");
      return;
    }
    const lang = speechLanguage(speechTag());
    const tag = speechTag();
    void loadDict(lang).catch(() => false).then(() => {
      if (gone.current) return;
      const tr = (key: TranslationKey, params?: Record<string, string | number>) => translate(lang, key, params);
      const read = landingRead(tab, transcript, sessionFocus);
      let first: string;
      if (read.kind === "where") {
        first = landing.where;
        speak("landing:where", first, tag);
      } else {
        first = tr("voice.nav.youAsked", { text: read.text });
        speak("landing:prompt", first, tag);
        if (read.kind === "fallback") speak("landing:none", tr("voice.nav.noAnswer"), tag);
        else if (!read.answered || !readTurn(tab.id, read.sinceKey)) speak("landing:none", tr("voice.nav.noAnswerYet"), tag);
      }
      setLine({ text: first, run: () => skip.current() });
      setPhase("speaking");
    });
  // `transcript` is the screen's own read: a poll that brings the same session again is not a new landing.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landing, phase, handsFree, connected, sessionFocus, transcript, waitedOut]);

  // Quiet after the last line (a beat of tail), then the mic opens for the
  // next prompt: dictation, the gate on.
  useEffect(() => {
    if (phase !== "speaking") return;
    let timer = 0;
    const open = () => {
      window.clearTimeout(timer);
      setLine(null);
      setPhase("done");
      void startVoiceRef.current({ gate: true });
    };
    const check = () => {
      window.clearTimeout(timer);
      if (currentSpeechId() === null) timer = window.setTimeout(open, NAV_TAIL_MS);
    };
    skip.current = () => { stopSpeaking(); open(); };
    const off = subscribeSpeech(check);
    check();
    return () => {
      off();
      window.clearTimeout(timer);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  return phase === "speaking" ? line : null;
}
