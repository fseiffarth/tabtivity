import { useEffect, useRef, useState } from "react";
import { useI18nStore, useT, type TranslationKey } from "../../lib/i18n";
import { IS_HOST_WINDOWS } from "../../lib/platform";
import { runInstallInTab } from "../../lib/installCommand";
import {
  DEFAULT_VOICE_MODEL,
  VOICE_MODELS,
  VOICE_MODEL_LABELS,
  VOICE_PAUSE_MS,
  startDesktopDictation,
  voiceErrorKey,
  voiceInputOffered,
  voiceLangOptions,
  voiceLangTag,
  voiceModelInstallCommand,
  voiceStatus,
  type DesktopDictation,
  type VoiceLangChoice,
  type VoiceModel,
  type VoiceModelState,
} from "../../lib/voice/desktopVoice";
import { useSettingsStore } from "../../stores/settings";
import { Dropdown } from "../common/Dropdown";
import { UntestedTag } from "../common/UntestedTag";
import { paintMicLevel } from "../../../shared/voice";

type Phase = "off" | "starting" | "preparing" | "listening";

/**
 * Dictation for the Chat's composer (`ReaderComposer`, docs/desktop_voice_plan.md
 * step 3): the mic button beside Send, the "Heard:" line, the pickers of the
 * speech model it listens with and the language it listens in, and the install card, on the backend's speech engine (`lib/voice/desktopVoice`). A settled segment
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
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const [phase, setPhase] = useState<Phase>("off");
  const [heard, setHeard] = useState("");
  const [problem, setProblem] = useState<TranslationKey | null>(null);
  /** The install card, while open: the catalog's speech models and the one picked. */
  const [install, setInstall] = useState<{ models: VoiceModelState[]; pick: VoiceModel } | null>(null);
  /** While a session runs: the model it listens with and the catalog's speech models. */
  const [using, setUsing] = useState<{ models: VoiceModelState[]; id: VoiceModel } | null>(null);
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
  const langChoice = (settings?.voice_lang ?? "auto") as VoiceLangChoice;

  const reset = () => {
    session.current = null;
    paintMicLevel(buttonRef.current, null);
    setPhase("off");
    setHeard("");
    setUsing(null);
  };

  /** `use`: the model to listen with (the card's pick), else the setting's;
   * `lang`: the language choice to listen in, else the setting's. */
  const start = async (use: string = model, lang: VoiceLangChoice = langChoice) => {
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
      const whisper = status.models.filter((m) => m.kind === "whisper");
      const chosen = whisper.find((m) => m.id === use);
      if (!chosen?.installed) {
        setInstall({ models: whisper, pick: use as VoiceModel });
        setPhase("off");
        return;
      }
      setUsing({ models: whisper, id: use as VoiceModel });
      const dictation = await startDesktopDictation({
        tabKey,
        model: use,
        lang: voiceLangTag(lang, uiLanguage),
        mode: "dictate",
        pauseMs: settings?.voice_pause_ms ?? VOICE_PAUSE_MS.default,
        headset: settings?.voice_headset ?? false,
      }, {
        onPreparing: () => setPhase("preparing"),
        // Also the backend's "sound is back" after a muted-mic warning.
        onStart: () => {
          setProblem(null);
          setPhase("listening");
        },
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

  /** The running session's picker: an installed model becomes the setting and
   * listening starts over with it; a missing one opens the install card. */
  const switchModel = async (id: VoiceModel) => {
    const current = using;
    if (!current || id === current.id) return;
    end();
    if (!current.models.some((m) => m.id === id && m.installed)) {
      setInstall({ models: current.models, pick: id });
      return;
    }
    try {
      await updateSettings({ voice_model: id });
    } catch (error) {
      setProblem(voiceErrorKey(error));
      return;
    }
    void start(id);
  };

  /** The running session's language picker: the pick becomes the setting and
   * listening starts over in it, with the model it listened with. */
  const switchLang = async (choice: VoiceLangChoice) => {
    const current = using;
    if (!current || choice === langChoice) return;
    end();
    try {
      await updateSettings({ voice_lang: choice });
    } catch (error) {
      setProblem(voiceErrorKey(error));
      return;
    }
    void start(current.id, choice);
  };

  const pickedHere = (target: { models: VoiceModelState[]; pick: VoiceModel }) =>
    target.models.some((m) => m.id === target.pick && m.installed);

  /** The card's button: switch to an installed model and dictate with it, or
   * install the picked one. Either way it becomes the setting. */
  const runInstall = async () => {
    const target = install;
    setInstall(null);
    if (!target) return;
    try {
      if (target.pick !== model) await updateSettings({ voice_model: target.pick });
      if (pickedHere(target)) {
        void start(target.pick);
        return;
      }
      const command = await voiceModelInstallCommand(target.pick);
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
  const picker = using && (phase === "preparing" || listening) ? (
    <div className="terminal-reader-voice-model">
      <span>{t("settings.voice.model")}</span>
      <Dropdown
        value={using.id}
        ariaLabel={t("settings.voice.model")}
        onChange={(value) => void switchModel(value as VoiceModel)}
        options={VOICE_MODELS.map((id) => ({
          value: id,
          label: `${t(VOICE_MODEL_LABELS[id])}${using.models.some((m) => m.id === id && m.installed) ? ` · ${t("settings.voice.installed")}` : ""}`,
        }))}
      />
      <UntestedTag id="terminal.reader.voice.modelPicker" />
      <span>{t("settings.voice.lang")}</span>
      <Dropdown
        value={langChoice}
        ariaLabel={t("settings.voice.lang")}
        onChange={(value) => void switchLang(value as VoiceLangChoice)}
        options={voiceLangOptions(t)}
      />
      <UntestedTag id="terminal.reader.voice.langPicker" />
    </div>
  ) : null;
  const strip = (line || install || picker) ? (
    <div className="terminal-reader-voice">
      {install && (
        <div className="terminal-reader-voice-card" role="dialog" aria-label={t("terminal.reader.voice.installTitle")}>
          <strong>{t("terminal.reader.voice.installTitle")}</strong>
          <span>{t("terminal.reader.voice.installBody")}</span>
          <Dropdown
            value={install.pick}
            ariaLabel={t("settings.voice.model")}
            onChange={(value) => setInstall({ ...install, pick: value as VoiceModel })}
            options={VOICE_MODELS.map((id) => ({
              value: id,
              label: `${t(VOICE_MODEL_LABELS[id])}${install.models.some((m) => m.id === id && m.installed) ? ` · ${t("settings.voice.installed")}` : ""}`,
            }))}
          />
          <div className="terminal-reader-voice-actions">
            <button type="button" className="settings-btn" onClick={() => void runInstall()}>{t(pickedHere(install) ? "terminal.reader.voice.use" : "terminal.reader.voice.install")}</button>
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
          {problem === "terminal.reader.voice.err.silent" && <UntestedTag id="terminal.reader.voice.silent" />}
        </div>
      )}
      {picker}
    </div>
  ) : null;

  return { button, strip, toggle, end, active: phase !== "off" };
}
