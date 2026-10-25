import { useEffect, useRef, useState } from "react";
import { useI18nStore, useT, type TranslationKey } from "../../lib/i18n";
import { IS_HOST_WINDOWS } from "../../lib/platform";
import { runInstallInTab } from "../../lib/installCommand";
import {
  DEFAULT_VOICE_MODEL,
  VOICE_PAUSE_MS,
  startDesktopDictation,
  voiceErrorKey,
  voiceInputOffered,
  voiceLangTag,
  voiceModelInstallCommand,
  voiceStatus,
  type DesktopDictation,
  type VoiceLangChoice,
  type VoiceModelState,
} from "../../lib/voice/desktopVoice";
import { playChime } from "../../lib/voice/chime";
import { sentTurnOver, useAgentTurn } from "../../lib/voice/agentTurn";
import { createSendGuard, type GuardPhase, type SendGuard } from "../../../shared/handsFree";
import { useSettingsStore } from "../../stores/settings";
import { UntestedTag } from "../common/UntestedTag";
import { paintMicLevel } from "../../../shared/voice";

type Phase = "off" | "starting" | "preparing" | "listening";

/** "small · 190 MB": the install card's model line. */
function modelSize(model: VoiceModelState | undefined): string {
  return model ? `${Math.round(model.sizeBytes / 1_000_000)} MB` : "";
}

/** The agent must have stayed done this long, and the voice quiet, before
 * hands-free opens the mic again. */
const REOPEN_SETTLE_MS = 800;

/**
 * Dictation for the Chat's composer (`ReaderComposer`, docs/desktop_voice_plan.md
 * step 3): the mic button beside Send, the "Heard:" line and the install card,
 * on the backend's speech engine (`lib/voice/desktopVoice`). A settled segment
 * goes to `onText`; the composer puts it in the draft and sends on a spoken
 * "go on". One mic per machine: starting it here stops it in any other tab,
 * whose session then ends.
 *
 * Hands-free (step 4, `handsFree`): the session listens in the backend's
 * `handsFree` mode, whose voice detector closes a segment only after the
 * pause; the settled segment opens the send guard (`shared/handsFree.ts`) —
 * a chime, then a cancel window in which "stop", the stop key or a click on
 * the line keeps the draft — and then `onSend`. While the agent works on what
 * was sent, the mic is paused (it keeps the session), and it listens again
 * once the turn is over (`sentTurnOver`) and the answer has been read
 * (`reading`). A settled segment that picks a row of the question on screen
 * (`pick`) answers it instead.
 *
 * The mic pauses while the pane is hidden and resumes when it is shown; the
 * session ends with the composer. A browser client offers no mic.
 */
export function useReaderVoice({ tabKey, ptyId, visible, disabled, handsFree, reading, questionOpen, lastAnswer, onText, onSend, hasDraft, pick, readProblem = null }: {
  tabKey: string;
  ptyId: string;
  visible: boolean;
  disabled: boolean;
  /** The hands-free loop is on (the experimental flag and the chip). */
  handsFree: boolean;
  /** Read-aloud owes or is saying an answer: the mic stays closed. */
  reading: boolean;
  /** A question waits on the user: the agent's turn is over for now. */
  questionOpen: boolean;
  /** The newest answer's key in the conversation. */
  lastAnswer: string | null;
  /** A settled segment's text (never empty). */
  onText: (text: string) => void;
  /** Hands-free's send: the composer's own. */
  onSend: () => void;
  hasDraft: () => boolean;
  /** Answers the question on screen when `utterance` picks one of its rows. */
  pick: (utterance: string) => boolean;
  /** Why read-aloud could not speak: said on the same line. */
  readProblem?: TranslationKey | null;
}) {
  const t = useT();
  const uiLanguage = useI18nStore((s) => s.lang);
  const settings = useSettingsStore((s) => s.settings);
  const [phase, setPhase] = useState<Phase>("off");
  const [heard, setHeard] = useState("");
  const [problem, setProblem] = useState<TranslationKey | null>(null);
  /** The model to install, while the install card is open. */
  const [install, setInstall] = useState<VoiceModelState | null>(null);
  const [guardPhase, setGuardPhase] = useState<GuardPhase>("idle");
  /** Hands-free sent at this time; the mic is paused until the turn is over. */
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const waitingRef = useRef(false);
  waitingRef.current = waitingSince !== null;
  /** The newest answer at the send, to tell this turn's from the last. */
  const answerAtSend = useRef<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const session = useRef<DesktopDictation | null>(null);
  /** The mode the running session listens in. */
  const sessionHandsFree = useRef(false);
  /** Bumped by every start and end, so a start that resolves late stops. */
  const attempt = useRef(0);
  const handlers = useRef({ onText, onSend, hasDraft, pick });
  useEffect(() => {
    handlers.current = { onText, onSend, hasDraft, pick };
  });
  const lastAnswerRef = useRef(lastAnswer);
  lastAnswerRef.current = lastAnswer;
  const offered = voiceInputOffered();

  const model = settings?.voice_model ?? DEFAULT_VOICE_MODEL;

  const guard = useRef<SendGuard | null>(null);
  // The voice detector already waited the pause before it closed the segment.
  guard.current ??= createSendGuard(0, {
    hasDraft: () => handlers.current.hasDraft(),
    onWindow: () => playChime(),
    onSend: () => handlers.current.onSend(),
    onCancel: () => {},
    onPhase: setGuardPhase,
  });

  const reset = () => {
    session.current = null;
    guard.current?.reset();
    paintMicLevel(buttonRef.current, null);
    setPhase("off");
    setHeard("");
  };

  /** Hands-free waits for the turn what was sent (or answered) starts. */
  const awaitTurn = () => {
    guard.current?.reset();
    answerAtSend.current = lastAnswerRef.current;
    setHeard("");
    setWaitingSince(Date.now());
  };

  const start = async () => {
    const mine = ++attempt.current;
    setProblem(null);
    setInstall(null);
    setPhase("starting");
    const loop = handsFree;
    try {
      const status = await voiceStatus();
      if (mine !== attempt.current) return;
      if (status.listen) {
        setProblem(voiceErrorKey(status.listen));
        setPhase("off");
        return;
      }
      const chosen = status.models.find((m) => m.id === model && m.kind === "whisper");
      if (!chosen?.installed) {
        setInstall(chosen ?? null);
        setPhase("off");
        return;
      }
      const dictation = await startDesktopDictation({
        tabKey,
        model,
        lang: voiceLangTag(settings?.voice_lang as VoiceLangChoice | undefined, uiLanguage),
        mode: loop ? "handsFree" : "dictate",
        pauseMs: settings?.voice_pause_ms ?? VOICE_PAUSE_MS.default,
        headset: settings?.voice_headset ?? false,
      }, {
        onPreparing: () => setPhase("preparing"),
        onStart: () => setPhase("listening"),
        onSegment: (open) => {
          if (!open) setHeard("");
          else if (sessionHandsFree.current && !waitingRef.current) guard.current?.speechStarted();
        },
        onPartial: (text) => { if (!waitingRef.current) setHeard(text); },
        onFinal: (text) => {
          setHeard("");
          if (!sessionHandsFree.current) {
            if (text) handlers.current.onText(text);
            return;
          }
          // Words still on their way from before a send are not the next prompt.
          if (waitingRef.current) return;
          if (text && handlers.current.pick(text)) {
            awaitTurn();
            return;
          }
          if (!guard.current?.settled(text)) return;
          if (text) handlers.current.onText(text);
        },
        onLevel: (level) => paintMicLevel(buttonRef.current, level),
        onPaused: () => {},
        onError: (key) => setProblem(key),
        onEnd: () => {
          if (session.current === dictation) reset();
        },
      });
      if (mine !== attempt.current) {
        dictation.abort();
        return;
      }
      sessionHandsFree.current = loop;
      session.current = dictation;
      if (!visible || waitingRef.current) dictation.pause(true);
    } catch (error) {
      if (mine !== attempt.current) return;
      setProblem(voiceErrorKey(error));
      reset();
    }
  };
  const startRef = useRef(start);
  startRef.current = start;

  const stop = () => {
    attempt.current += 1;
    setWaitingSince(null);
    guard.current?.reset();
    const active = session.current;
    if (active) active.stop();
    else reset();
  };

  /** A send empties the draft: what is still on its way must not land in it.
   * Hands-free keeps the session, paused, for the answer's turn. */
  const end = () => {
    if (session.current && sessionHandsFree.current) {
      awaitTurn();
      return;
    }
    attempt.current += 1;
    const active = session.current;
    reset();
    active?.abort();
  };

  const toggle = () => {
    if (!offered || disabled) return;
    if (phase === "off" && waitingSince === null) void start();
    else stop();
  };

  /** The stop key or a click on the line: a send window is cancelled. */
  const cancelSend = () => guard.current?.cancel();

  // A hidden pane is no place to dictate into, nor is a turn still running.
  useEffect(() => {
    session.current?.pause(!visible || waitingSince !== null);
  }, [visible, waitingSince]);
  // Switching the loop on or off mid-session: the next start takes the mode.
  useEffect(() => {
    if (!handsFree) setWaitingSince(null);
    if (session.current && sessionHandsFree.current !== handsFree) {
      attempt.current += 1;
      const active = session.current;
      reset();
      active.abort();
    }
  }, [handsFree]);
  // The composer going away ends its dictation.
  useEffect(() => () => {
    attempt.current += 1;
    session.current?.abort();
    session.current = null;
    guard.current?.reset();
  }, [tabKey]);

  // Hands-free: the turn over and the answer read — the mic listens again.
  // With a headset it listens while the answer is read: talking over the
  // voice stops it (the backend's barge-in), and the words go in the draft.
  const headset = settings?.voice_headset ?? false;
  const turn = useAgentTurn(ptyId, waitingSince !== null);
  useEffect(() => {
    if (waitingSince === null) return;
    const over = questionOpen || sentTurnOver(turn.reading, waitingSince, turn.litSince, lastAnswer !== answerAtSend.current);
    if (!over || (reading && !headset) || !visible) return;
    const timer = setTimeout(() => {
      setWaitingSince(null);
      if (!session.current) void startRef.current();
    }, REOPEN_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [waitingSince, turn, questionOpen, lastAnswer, reading, headset, visible]);

  const runInstall = async () => {
    const target = install;
    setInstall(null);
    if (!target) return;
    try {
      const command = await voiceModelInstallCommand(target.id);
      runInstallInTab(t("terminal.reader.voice.installTab"), command, IS_HOST_WINDOWS ? "powershell" : "bash");
    } catch (error) {
      setProblem(voiceErrorKey(error));
    }
  };

  const waiting = waitingSince !== null;
  const listening = phase === "listening" && !waiting;
  const busy = phase === "starting" || phase === "preparing";
  const label = t(listening || waiting ? "terminal.reader.voice.stop" : busy ? "terminal.reader.voice.preparing" : "terminal.reader.voice.dictate");
  const button = offered ? (
    <button
      ref={buttonRef}
      type="button"
      className={`terminal-reader-mic${listening ? " listening" : ""}${busy ? " preparing" : ""}${waiting ? " waiting" : ""}`}
      disabled={disabled && phase === "off" && !waiting}
      onClick={toggle}
      aria-label={label}
      aria-pressed={listening || waiting}
      title={label}
    >
      {listening || waiting
        ? <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" /></svg>
        : <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4M8 21h8" /></svg>}
    </button>
  ) : null;

  const inWindow = guardPhase === "window" || guardPhase === "holding";
  const shownProblem = problem ?? readProblem;
  const line = shownProblem ? t(shownProblem)
    : inWindow ? t("terminal.reader.voice.sendWindow")
    : waiting ? t(reading ? "terminal.reader.voice.reading" : "terminal.reader.voice.waiting")
    : heard ? t("terminal.reader.voice.heard", { text: heard })
    : phase === "preparing" ? t("terminal.reader.voice.preparing")
    : listening ? t(sessionHandsFree.current ? "terminal.reader.voice.listeningHandsFree" : "terminal.reader.voice.listening")
    : "";
  const strip = (line || install) ? (
    <div className="terminal-reader-voice">
      {install && (
        <div className="terminal-reader-voice-card" role="dialog" aria-label={t("terminal.reader.voice.installTitle")}>
          <strong>{t("terminal.reader.voice.installTitle")}</strong>
          <span>{t("terminal.reader.voice.installBody", { model: install.id, size: modelSize(install) })}</span>
          <div className="terminal-reader-voice-actions">
            <button type="button" className="settings-btn" onClick={() => void runInstall()}>{t("terminal.reader.voice.install")}</button>
            <button type="button" className="settings-btn" onClick={() => setInstall(null)}>{t("terminal.reader.voice.notNow")}</button>
          </div>
          <UntestedTag id="terminal.reader.voice.install" />
        </div>
      )}
      {line && !shownProblem && inWindow ? (
        <button type="button" className="terminal-reader-voice-line send-window" aria-live="polite" onClick={cancelSend}>
          {line}
          <UntestedTag id="terminal.reader.voice.handsFree" />
        </button>
      ) : line && (
        <div className={shownProblem ? "terminal-reader-voice-line error" : "terminal-reader-voice-line"} role={shownProblem ? "alert" : "status"} aria-live="polite">
          {line}
          {listening && !heard && !shownProblem && (sessionHandsFree.current
            ? <UntestedTag id="terminal.reader.voice.handsFree" />
            : <UntestedTag id="terminal.reader.voice.spokenSend" />)}
          {(heard || phase === "preparing") && !shownProblem && <UntestedTag id="terminal.reader.voice.dictate" />}
        </div>
      )}
    </div>
  ) : null;

  return {
    button, strip, toggle, end, cancelSend,
    active: phase !== "off" || waiting,
    listening,
    /** Read-aloud may speak while this listens: a headset in hands-free. */
    speakOver: sessionHandsFree.current && headset,
  };
}
