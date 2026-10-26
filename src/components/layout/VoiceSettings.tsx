import { useEffect, useState } from "react";
import { LANGUAGES, useT, type TranslationKey } from "../../lib/i18n";
import { IS_HOST_WINDOWS } from "../../lib/platform";
import { runInstallInTab } from "../../lib/installCommand";
import {
  DEFAULT_VOICE_MODEL,
  VOICE_MODEL_LABELS,
  VOICE_MODELS,
  voiceErrorKey,
  voiceModelInstallCommand,
  voiceStatus,
  type VoiceStatus,
} from "../../lib/voice/desktopVoice";
import { useSettingsStore } from "../../stores/settings";
import { Dropdown } from "../common/Dropdown";
import { UntestedTag } from "../common/UntestedTag";
import { SettingRow } from "./settingsUi";

/**
 * Settings → Voice (docs/desktop_voice_plan.md, step 3): the speech model
 * the Chat dictates with — installed in a tab, one click — and the language
 * it listens in. Read-aloud's voice and rate, headset mode and the
 * hands-free pause come with read-aloud and hands-free (steps 2c and 4).
 */
export function VoiceSettings() {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [problem, setProblem] = useState<TranslationKey | null>(null);
  useEffect(() => {
    void voiceStatus().then(setStatus, (error: unknown) => setProblem(voiceErrorKey(error)));
  }, []);

  const model = settings?.voice_model ?? DEFAULT_VOICE_MODEL;
  const installed = (id: string) => status?.models.some((m) => m.id === id && m.installed) ?? false;
  const unavailable = problem ?? (status?.listen ? voiceErrorKey(status.listen) : null);

  const install = async () => {
    try {
      runInstallInTab(t("terminal.reader.voice.installTab"), await voiceModelInstallCommand(model), IS_HOST_WINDOWS ? "powershell" : "bash");
    } catch (error) {
      setProblem(voiceErrorKey(error));
    }
  };

  return (
    <>
      {unavailable && <p role="alert" className="settings-error">{t(unavailable)}</p>}
      <SettingRow
        label={<>{t("settings.voice.model")} <UntestedTag id="terminal.reader.voice.install" /></>}
        help={t("settings.voice.modelHelp")}
        control={
          <span className="settings-voice-model">
            <Dropdown
              value={model}
              ariaLabel={t("settings.voice.model")}
              onChange={(value) => void updateSettings({ voice_model: value })}
              options={VOICE_MODELS.map((id) => ({
                value: id,
                label: `${t(VOICE_MODEL_LABELS[id])}${installed(id) ? ` · ${t("settings.voice.installed")}` : ""}`,
              }))}
            />
            {status && !installed(model) && !status.listen && (
              <button type="button" className="settings-btn" onClick={() => void install()}>
                {t("terminal.reader.voice.install")}
              </button>
            )}
          </span>
        }
      />
      <SettingRow
        label={t("settings.voice.lang")}
        help={t("settings.voice.langHelp")}
        control={
          <Dropdown
            value={settings?.voice_lang ?? "auto"}
            ariaLabel={t("settings.voice.lang")}
            onChange={(value) => void updateSettings({ voice_lang: value })}
            options={[
              { value: "auto", label: t("settings.voice.langAuto") },
              ...LANGUAGES.map((language) => ({ value: language.value, label: language.label })),
              { value: "detect", label: t("settings.voice.langDetect") },
            ]}
          />
        }
      />
    </>
  );
}
