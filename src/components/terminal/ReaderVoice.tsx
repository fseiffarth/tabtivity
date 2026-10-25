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
import { useSettingsStore } from "../../stores/settings";
import { UntestedTag } from "../common/UntestedTag";
import { paintMicLevel } from "../../../shared/voice";

type Phase = "off" | "starting" | "preparing" | "listening";

/** "small · 190 MB": the install card's model line. */
function modelSize(model: VoiceModelState | undefined): string {
  return model ? `${Math.round(model.sizeBytes / 1_000_000)} MB` : "";
}

/**
 * Dictation for the Chat's composer (`ReaderComposer`, docs/desktop_voice_plan.md
 * step 3): the mic button beside Send, the "Heard:" line and the install card,
 * on the backend's speech engine (`lib/voice/desktopVoice`). A settled segment
 * goes to `onText`; the composer puts it in the draft and sends on a spoken
 * "go on". One mic per machine: starting it here stops it in any other tab,
 * whose session then ends.
 *
 * The mic pauses while the pane is hidden and resumes when it is shown; the
 * session ends with the composer. A browser client offers no mic.
 */
export function useReaderVoice({ tabKey, visible, disabled, onText }: {
  tabKey: string;
  visible: boolean;
  disabled: boolean;
  /** A settled segment's text (never empty). */
  onText: (text: string) => void;
}) {
  const t = useT();
  const uiLanguage = useI18nStore((s) => s.lang);
  const settings = useSettingsStore((s) => s.settings);
  const [phase, setPhase] = useState<Phase>("off");
  const [heard, setHeard] = useState("");
  const [problem, setProblem] = useState<TranslationKey | null>(null);
  /** The model to install, while the install card is open. */
  const [install, setInstall] = useState<VoiceModelState | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const session = useRef<DesktopDictation | null>(null);
  /** Bumped by every start and end, so a start that resolves late stops. */
  const attempt = useRef(0);
  const onTextRef = useRef(onText);
  useEffect(() => {
    onTextRef.current = onText;
  });
  const offered = voiceInputOffered();

  const model = settings?.voice_model ?? DEFAULT_VOICE_MODEL;

  const reset = () => {
    session.current = null;
    paintMicLevel(buttonRef.current, null);
    setPhase("off");
    setHeard("");
  };

  const start = async () => {
    const mine = ++attempt.current;
    setProblem(null);
    setInstall(null);
    setPhase("starting");
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
        mode: "dictate",
        pauseMs: settings?.voice_pause_ms ?? VOICE_PAUSE_MS.default,
        headset: settings?.voice_headset ?? false,
      }, {
        onPreparing: () => setPhase("preparing"),
        onStart: () => setPhase("listening"),
        onSegment: (open) => { if (!open) setHeard(""); },
        onPartial: (text) => setHeard(text),
        onFinal: (text) => {
          setHeard("");
          if (text) onTextRef.current(text);
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
      session.current = dictation;
    } catch (error) {
      if (mine !== attempt.current) return;
      setProblem(voiceErrorKey(error));
      reset();
    }
  };

  const stop = () => {
    attempt.current += 1;
    const active = session.current;
    if (active) active.stop();
    else reset();
  };

  /** A send empties the draft: what is still on its way must not land in it. */
  const end = () => {
    attempt.current += 1;
    const active = session.current;
    reset();
    active?.abort();
  };

  const toggle = () => {
    if (!offered || disabled) return;
    if (phase === "off") void start();
    else stop();
  };

  // A hidden pane is no place to dictate into; it listens again when shown.
  useEffect(() => {
    session.current?.pause(!visible);
  }, [visible]);
  // The composer going away ends its dictation.
  useEffect(() => () => {
    attempt.current += 1;
    session.current?.abort();
    session.current = null;
  }, [tabKey]);

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

  const listening = phase === "listening";
  const busy = phase === "starting" || phase === "preparing";
  const label = t(listening ? "terminal.reader.voice.stop" : busy ? "terminal.reader.voice.preparing" : "terminal.reader.voice.dictate");
  const button = offered ? (
    <button
      ref={buttonRef}
      type="button"
      className={`terminal-reader-mic${listening ? " listening" : ""}${busy ? " preparing" : ""}`}
      disabled={disabled && phase === "off"}
      onClick={toggle}
      aria-label={label}
      aria-pressed={listening}
      title={label}
    >
      {listening
        ? <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" /></svg>
        : <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4M8 21h8" /></svg>}
    </button>
  ) : null;

  const line = problem ? t(problem)
    : heard ? t("terminal.reader.voice.heard", { text: heard })
    : phase === "preparing" ? t("terminal.reader.voice.preparing")
    : listening ? t("terminal.reader.voice.listening")
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
      {line && (
        <div className={problem ? "terminal-reader-voice-line error" : "terminal-reader-voice-line"} role={problem ? "alert" : "status"} aria-live="polite">
          {line}
          {listening && !heard && !problem && <UntestedTag id="terminal.reader.voice.spokenSend" />}
          {(heard || phase === "preparing") && !problem && <UntestedTag id="terminal.reader.voice.dictate" />}
        </div>
      )}
    </div>
  ) : null;

  return { button, strip, toggle, end, active: phase !== "off" };
}
