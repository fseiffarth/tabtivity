import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SettingsCard } from "../layout/settingsUi";
import { Dropdown } from "../common/Dropdown";
import { UntestedTag } from "../common/UntestedTag";
import { useSettingsStore } from "../../stores/settings";
import { runInstallInTab, type InstallShellKind } from "../../lib/installCommand";
import { useT } from "../../lib/i18n";

/** What the backend's `ollama_keep_alive_plan` reports. */
interface OllamaKeepAlivePlan {
  /** `OLLAMA_KEEP_ALIVE` in the app's environment; it outranks the setting. */
  env: string | null;
  /** A systemd unit runs the server; only the drop-in reaches it. */
  systemd: boolean;
  /** The service's own value; null is Ollama's default. */
  service_value: string | null;
  /** The drop-in command for the chosen value; empty without a service. */
  service_cmd: string;
  shell_kind: string;
}

const CHOICES = ["30m", "1h", "-1"] as const;

/**
 * How long Ollama keeps a model loaded after its last request (`settings.
 * ollama_keep_alive`, `OLLAMA_KEEP_ALIVE`). Agents reach Ollama through its
 * OpenAI-compatible API, which cannot ask for longer per request, so an idle
 * local-model tab lost its model after Ollama's 5 minutes. A server the app
 * starts reads it at start (hence Restart after a change); a systemd service
 * gets the one-click drop-in, as the models folder does.
 */
export function OllamaKeepAliveCard({
  restarting,
  onRestart,
}: {
  restarting: boolean;
  onRestart: () => void;
}) {
  const t = useT();
  const setting = useSettingsStore((s) => s.settings?.ollama_keep_alive ?? null);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const [plan, setPlan] = useState<OllamaKeepAlivePlan | null>(null);
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<OllamaKeepAlivePlan>("ollama_keep_alive_plan", { value: setting })
      .then((p) => {
        if (!cancelled) setPlan(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [setting]);

  const label = (value: string | null): string => {
    switch (value) {
      case null:
      case "":
        return t("ollama.keepAliveDefault");
      case "30m":
        return t("ollama.keepAlive30m");
      case "1h":
        return t("ollama.keepAlive1h");
      case "-1":
        return t("ollama.keepAliveForever");
      default:
        return value;
    }
  };
  const options = [{ value: "", label: label(null) }, ...CHOICES.map((c) => ({ value: c, label: label(c) }))];
  // A value set by hand in settings.json that is not a choice still shows.
  if (setting && !(CHOICES as readonly string[]).includes(setting)) options.push({ value: setting, label: setting });

  const serviceDiffers = !!plan?.systemd && (plan.service_value ?? null) !== (setting || null);
  const applyToService = () => {
    if (!plan?.service_cmd) return;
    runInstallInTab(t("ollama.keepAliveApplyTabLabel"), plan.service_cmd, (plan.shell_kind || "bash") as InstallShellKind);
  };

  return (
    <SettingsCard>
      <div className="settings-subheader">
        {t("ollama.keepAliveTitle")} <UntestedTag id="ollama.keepAliveTitle" />
      </div>
      <div className="ollama-path-row">
        <Dropdown
          value={setting ?? ""}
          options={options}
          disabled={!!plan?.env}
          ariaLabel={t("ollama.keepAliveTitle")}
          onChange={(v) => {
            setChanged(true);
            void updateSettings({ ollama_keep_alive: v === "" ? null : v });
          }}
        />
      </div>
      {plan?.env && <p className="settings-help">{t("ollama.keepAliveEnv", { value: plan.env })}</p>}
      {!plan?.env && plan?.systemd && (
        <>
          <p className="settings-help">{t("ollama.keepAliveService", { value: label(plan.service_value) })}</p>
          {serviceDiffers && plan.service_cmd && (
            <div className="ollama-install-cmd-row">
              <button type="button" className="ollama-action-btn primary" title={plan.service_cmd} onClick={applyToService}>
                {t("ollama.keepAliveApply")}
              </button>
            </div>
          )}
        </>
      )}
      {!plan?.env && plan && !plan.systemd && changed && (
        <div className="ollama-path-row">
          <span className="settings-help">{t("ollama.keepAlivePending")}</span>
          <button type="button" className="ollama-action-btn primary" disabled={restarting} onClick={onRestart}>
            {restarting ? t("localModel.restartingOllama") : t("localModel.restartOllama")}
          </button>
        </div>
      )}
      <p className="settings-help">{t("ollama.keepAliveHelp")}</p>
    </SettingsCard>
  );
}
