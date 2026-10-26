import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useI18nStore, useT, type TranslationKey } from "../../lib/i18n";
import { speechChunks, spokenText } from "../../../shared/voice";
import {
  SPEAK_LIMITS,
  VOICE_EVENTS,
  voiceErrorKey,
  voiceInputOffered,
  voiceLangTag,
  voiceSpeak,
  voiceSpeakStop,
  type SpeakingEvent,
  type VoiceLangChoice,
} from "../../lib/voice/desktopVoice";
import { useSettingsStore } from "../../stores/settings";
import { useTauriListener } from "../../hooks/useTauriListener";

/** A chunk the OS voice says whole; short, so a stop is heard at once. */
const SPEAK_CHUNK = 300;
/** More new answers than this at one turn's end is a session swapped in or
 * read in, not news. */
const MAX_SPOKEN_AT_ONCE = 3;
/** How long after a turn's end its answer may still arrive to be read. */
const DUE_LIMIT_MS = 10_000;

/** One answer of the conversation, as the Reader's turns carry it. */
export interface SpokenTurn {
  key: string;
  kind: string;
  text: string;
}

/**
 * Read-aloud for the Chat (docs/desktop_voice_plan.md step 4): when the
 * agent's turn ends (`turnEnd`, from `useAgentTurn`), each new answer is
 * spoken by the OS voice (`voice_speak`) — once, and only a short new tail:
 * what the first read brought, or "earlier" reveals, is history. Nothing is
 * read while the user dictates, nor while the pane is hidden; an answer that
 * came while it was hidden is read when it is shown again.
 *
 * `say` reads anything else in the same voice (a question card, for
 * hands-free); `speaking` is whether one of this tab's reads is being said,
 * `owed` also while a turn's answer is still to come; `stop` ends it (the
 * stop key, the indicator, a send).
 */
export function useReaderReadAloud({ readId, enabled, visible, listening, turns, turnEnd, working }: {
  /** Prefix of this tab's read ids (its PTY id). */
  readId: string;
  enabled: boolean;
  visible: boolean;
  /** The mic is listening: nothing is said over it. */
  listening: boolean;
  turns: readonly SpokenTurn[];
  /** The last ended turn's key (`useAgentTurn`), `null` while one runs. */
  turnEnd: string | null;
  working: boolean;
}) {
  const t = useT();
  const uiLanguage = useI18nStore((s) => s.lang);
  const settings = useSettingsStore((s) => s.settings);
  const [speaking, setSpeaking] = useState(false);
  const [problem, setProblem] = useState<TranslationKey | null>(null);
  /** This tab's reads being said, by id. */
  const live = useRef(new Set<string>());
  const offered = voiceInputOffered();

  useTauriListener(() => (offered
    ? listen<SpeakingEvent>(VOICE_EVENTS.speaking, ({ payload }) => {
      if (!payload.readId.startsWith(`${readId}#`)) return;
      if (payload.state === "started") live.current.add(payload.readId);
      else live.current.delete(payload.readId);
      if (payload.state === "failed" && payload.reason) setProblem(voiceErrorKey(payload.reason));
      setSpeaking(live.current.size > 0);
    })
    : Promise.resolve(() => {})), [readId, offered]);

  const lang = () => {
    const tag = voiceLangTag(settings?.voice_lang as VoiceLangChoice | undefined, uiLanguage);
    // Whisper may guess the language it hears; a voice must be told one.
    return tag === "auto" ? uiLanguage : tag;
  };
  const say = (id: string, text: string) => {
    const chunks = speechChunks(text, SPEAK_CHUNK).slice(0, SPEAK_LIMITS.chunks);
    if (chunks.length === 0 || !offered) return;
    setProblem(null);
    const rate = Math.min(SPEAK_LIMITS.rate.max, Math.max(SPEAK_LIMITS.rate.min, settings?.voice_rate ?? 1));
    void voiceSpeak(`${readId}#${id}`, chunks, lang(), rate).catch((error: unknown) => setProblem(voiceErrorKey(error)));
  };
  const sayRef = useRef(say);
  sayRef.current = say;

  const stop = useCallback(() => {
    if (live.current.size === 0) return;
    live.current.clear();
    setSpeaking(false);
    void voiceSpeakStop().catch(() => {});
  }, []);

  /** The answers already said or passed over, by key; `null` until the first
   * look, whose answers are history. */
  const known = useRef<Set<string> | null>(null);
  /** A turn ended and its answer is still to come into the transcript. A turn
   * that ends with no answer (only tool calls) owes nothing after a while. */
  const [due, setDue] = useState(false);
  useEffect(() => {
    if (!due) return;
    const timer = setTimeout(() => setDue(false), DUE_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [due]);
  const firstEnd = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    // What had ended before this look is no news.
    if (firstEnd.current === undefined) {
      firstEnd.current = turnEnd;
      return;
    }
    if (turnEnd !== null && turnEnd !== firstEnd.current) setDue(true);
  }, [turnEnd]);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const answerKeys = (list: readonly SpokenTurn[]) => new Set(list.filter((turn) => turn.kind === "answer").map((turn) => turn.key));
  // Switched on: what came while it was off is history too.
  useEffect(() => {
    if (!enabled) return;
    setDue(false);
    if (turnsRef.current.length > 0) known.current = answerKeys(turnsRef.current);
  }, [enabled]);
  // A new turn takes back a read the last one still owed, and what the
  // conversation holds as it starts is history.
  useEffect(() => {
    if (!working) return;
    setDue(false);
    known.current = answerKeys(turnsRef.current);
  }, [working]);

  useEffect(() => {
    const answers = turns.filter((turn) => turn.kind === "answer");
    // The first conversation read in is history (an empty one is no read yet).
    if (known.current === null) {
      if (turns.length > 0) known.current = answerKeys(turns);
      return;
    }
    if (!due || !enabled || !visible) return;
    let last = -1;
    answers.forEach((turn, index) => {
      if (known.current?.has(turn.key)) last = index;
    });
    const fresh = answers.slice(last + 1);
    if (fresh.length === 0) return;
    for (const turn of fresh) known.current.add(turn.key);
    setDue(false);
    if (listening || fresh.length > MAX_SPOKEN_AT_ONCE) return;
    const code = t("terminal.reader.voice.code");
    for (const turn of fresh) sayRef.current(turn.key, spokenText(turn.text, code));
  }, [turns, due, enabled, visible, listening, t]);

  // Hidden, or off: the voice goes quiet.
  useEffect(() => {
    if (!visible || !enabled) stop();
  }, [visible, enabled, stop]);
  useEffect(() => stop, [readId, stop]);

  /** An answer is still to be read, or being read: hands-free opens the mic
   * only after it. */
  const owed = speaking || (due && enabled && visible);
  return { speaking, owed, problem, say: (id: string, text: string) => sayRef.current(id, text), stop };
}
