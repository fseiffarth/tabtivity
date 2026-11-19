import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SettingsCard } from "../layout/settingsUi";
import { Dropdown } from "../common/Dropdown";
import { UntestedTag } from "../common/UntestedTag";
import { useSettingsStore } from "../../stores/settings";
import { useOllamaActivityStore } from "../../stores/agents/ollamaActivity";
import { useT } from "../../lib/i18n";

/** What the backend's `ollama_context_plan` reports. */
interface OllamaContextPlan {
  /** `OLLAMA_CONTEXT_LENGTH` in the app's environment; it outranks the setting. */
  env: string | null;
  /** The automatic window for a spawned server; null keeps Ollama's default. */
  auto: number | null;
  /** A systemd unit runs the server, so the setting never reaches it. */
  systemd: boolean;
}

const SIZES = [8_192, 16_384, 32_768, 65_536, 131_072];

/**
 * The context window a server the app starts gets (`settings.
 * ollama_context_length`), and what the loaded models actually have. Ollama
 * reads it only at start, hence the Restart button when the two disagree.
 */
export function OllamaContextCard({
  restarting,
  onRestart,
}: {
  restarting: boolean;
  onRestart: () => void;
}) {
  const t = useT();
  const setting = useSettingsStore((s) => s.settings?.ollama_context_length ?? null);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const models = useOllamaActivityStore((s) => s.models);
  const [plan, setPlan] = useState<OllamaContextPlan | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<OllamaContextPlan>("ollama_context_plan")
      .then((p) => {
        if (!cancelled) setPlan(p);
      })
      .catch(() => {});
    // The loaded sizes come from the shared model list; read it once here, the
    // panel's own list is a different command.
    void useOllamaActivityStore.getState().fetchModels();
    return () => {
      cancelled = true;
    };
  }, []);

  const fmt = (n: number) => n.toLocaleString();
  const overridden = !!plan?.env || !!plan?.systemd;
  const options = [
    {
      value: "",
      label: plan?.auto ? t("ollama.contextAuto", { size: fmt(plan.auto) }) : t("ollama.contextAutoDefault"),
    },
    ...SIZES.map((n) => ({ value: String(n), label: t("ollama.contextTokens", { size: fmt(n) }) })),
  ];
  // A value set by hand in settings.json that is not a preset still shows.
  if (setting != null && !SIZES.includes(setting)) {
    options.push({ value: String(setting), label: t("ollama.contextTokens", { size: fmt(setting) }) });
  }

  const wanted = overridden ? null : (setting ?? plan?.auto ?? null);
  const loaded = models.filter((m) => m.running && m.context_length != null);
  // Only a smaller window is flagged: Ollama may cap a model below the
  // setting at its own trained maximum, which no restart changes.
  const pending = wanted != null && loaded.some((m) => (m.context_length ?? 0) < wanted);

  return (
    <SettingsCard>
      <div className="settings-subheader">
        {t("ollama.contextTitle")} <UntestedTag id="ollama.contextTitle" />
      </div>
      <div className="ollama-path-row">
        <Dropdown
          value={setting == null ? "" : String(setting)}
          options={options}
          disabled={overridden}
          ariaLabel={t("ollama.contextLabel")}
          onChange={(v) => void updateSettings({ ollama_context_length: v === "" ? null : Number(v) })}
        />
      </div>
      {loaded.map((m) => (
        <p key={m.name} className="settings-help">
          {t("ollama.contextLoaded", { model: m.name, size: fmt(m.context_length ?? 0) })}
        </p>
      ))}
      {pending && wanted != null && (
        <div className="ollama-path-row">
          <span className="settings-help">{t("ollama.contextPending", { size: fmt(wanted) })}</span>
          <button type="button" className="ollama-action-btn primary" disabled={restarting} onClick={onRestart}>
            {restarting ? t("localModel.restartingOllama") : t("localModel.restartOllama")}
          </button>
        </div>
      )}
      {plan?.env && <p className="settings-help">{t("ollama.contextEnv", { value: plan.env })}</p>}
      {!plan?.env && plan?.systemd && <p className="settings-help">{t("ollama.contextSystemd")}</p>}
      <p className="settings-help">{t("ollama.contextHelp")}</p>
    </SettingsCard>
  );
}
