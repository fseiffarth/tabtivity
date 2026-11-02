import { useEffect, useState } from "react";
import { useT, type TranslationKey } from "../../lib/i18n";
import { IS_HOST_WINDOWS } from "../../lib/platform";
import { runInstallInTab } from "../../lib/installCommand";
import {
  DEFAULT_VOICE_MODEL,
  VOICE_MODEL_LABELS,
  VOICE_MODELS,
  VOICE_PAUSE_MS,
  retryVoiceGpu,
  voiceDeviceLabel,
  voiceDeviceWhy,
  voiceErrorKey,
  voiceLangOptions,
  voiceModelInstallCommand,
  voiceStatus,
  type VoiceStatus,
} from "../../lib/voice/desktopVoice";
import { useSettingsStore } from "../../stores/settings";
import { Dropdown } from "../common/Dropdown";
import { UntestedTag } from "../common/UntestedTag";
import { SettingRow, ToggleCard } from "./settingsUi";

/** Read-aloud's speeds, as the multiplier `voice_speak` takes. */
const RATES = [0.75, 1, 1.25, 1.5] as const;
/** The hands-free pauses offered, in ms, inside the backend's range. */
const PAUSES = [1000, 1500, 2000, 3000] as const;

/**
 * Settings → Voice (docs/desktop_voice_plan.md, steps 3 and 4): the speech
 * model the Chat dictates with — installed in a tab, one click — and the
 * language it listens in; read-aloud's speed on the system voice (the one
 * voice engine of phase 1); headset mode, in which talking over the voice
 * stops it; the pause after which hands-free sends; and whether speech may
 * use the GPU, with what the last dictation really ran on
 * (docs/voice_gpu_plan.md).
 */
export function VoiceSettings() {
  const t = useT();
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [problem, setProblem] = useState<TranslationKey | null>(null);
  const refresh = () => voiceStatus().then(setStatus, (error: unknown) => setProblem(voiceErrorKey(error)));
  useEffect(() => {
    void refresh();
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

  const retryGpu = async () => {
    await retryVoiceGpu().catch((error: unknown) => setProblem(voiceErrorKey(error)));
    await refresh();
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
            options={voiceLangOptions(t)}
          />
        }
      />
      <SettingRow
        label={<>{t("settings.voice.rate")} <UntestedTag id="terminal.reader.voice.readAloud" /></>}
        help={t(status?.speak ? voiceErrorKey(status.speak) : "settings.voice.rateHelp")}
        control={
          <Dropdown
            value={String(settings?.voice_rate ?? 1)}
            ariaLabel={t("settings.voice.rate")}
            onChange={(value) => void updateSettings({ voice_rate: Number(value) })}
            options={RATES.map((rate) => ({ value: String(rate), label: `${rate}×` }))}
          />
        }
      />
      <ToggleCard
        label={<>{t("settings.voice.headset")} <UntestedTag id="terminal.reader.voice.headsetBargeIn" /></>}
        checked={settings?.voice_headset ?? false}
        onChange={(e) => void updateSettings({ voice_headset: e.target.checked })}
        help={t("settings.voice.headsetHelp")}
      />
      {status?.gpuBuilt && (
        <ToggleCard
          label={<>{t("settings.voice.gpu")} <UntestedTag id="settings.voice.gpu" /></>}
          checked={settings?.voice_gpu ?? true}
          onChange={(e) => void updateSettings({ voice_gpu: e.target.checked })}
          help={t("settings.voice.gpuHelp")}
        />
      )}
      {status?.gpuCrashed && (
        <SettingRow
          label={t("settings.voice.gpuCrashed")}
          help={t("settings.voice.gpuCrashedHelp")}
          control={<button type="button" className="settings-btn" onClick={() => void retryGpu()}>{t("settings.voice.gpuRetry")}</button>}
        />
      )}
      {status?.device && (
        <SettingRow
          label={<>{t("settings.voice.device")} <UntestedTag id="terminal.reader.voice.device" /></>}
          help={voiceDeviceWhy(status.device, t) ?? t("settings.voice.deviceHelp")}
          control={<span>{voiceDeviceLabel(status.device, t)}</span>}
        />
      )}
      <SettingRow
        label={t("settings.voice.pause")}
        help={t("settings.voice.pauseHelp")}
        control={
          <Dropdown
            value={String(settings?.voice_pause_ms ?? VOICE_PAUSE_MS.default)}
            ariaLabel={t("settings.voice.pause")}
            onChange={(value) => void updateSettings({ voice_pause_ms: Number(value) })}
            options={PAUSES.map((ms) => ({ value: String(ms), label: t("settings.voice.seconds", { n: ms / 1000 }) }))}
          />
        }
      />
    </>
  );
}
