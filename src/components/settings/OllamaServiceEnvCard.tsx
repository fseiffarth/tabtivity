import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SettingsCard } from "../layout/settingsUi";
import { Dropdown } from "../common/Dropdown";
import { UntestedTag } from "../common/UntestedTag";
import { useSettingsStore } from "../../stores/settings";
import { runInstallInTab, type InstallShellKind } from "../../lib/installCommand";
import { useT, type TranslationKey } from "../../lib/i18n";
import type { Settings } from "../../types";
import type { UntestedId } from "../../lib/untested";

/** What the backend's `ollama_*_plan` commands report (`OllamaServicePlan`). */
interface OllamaServicePlan {
  /** The variable in the app's environment; it outranks the setting. */
  env: string | null;
  /** A systemd unit runs the server; only the drop-in reaches it. */
  systemd: boolean;
  /** The service's own value; null is Ollama's default. */
  service_value: string | null;
  /** The drop-in command for the chosen value; empty without a service. */
  service_cmd: string;
  shell_kind: string;
}

type SettingKey = "ollama_keep_alive" | "ollama_kv_cache_type";

const patchOf = (key: SettingKey, value: string | null): Partial<Settings> =>
  key === "ollama_keep_alive" ? { ollama_keep_alive: value } : { ollama_kv_cache_type: value };

/** The texts of one card; `env` takes `{value}`, `service` the label. */
interface CardTexts {
  title: TranslationKey;
  env: TranslationKey;
  service: TranslationKey;
  apply: TranslationKey;
  applyTabLabel: TranslationKey;
  pending: TranslationKey;
  help: TranslationKey;
  /** The card's `UntestedTag` id, while it has one (`npm run untested`). */
  untested?: UntestedId;
}

/**
 * A Local models setting carried by one of the Ollama server's environment
 * variables. A server the app starts reads it at start (hence Restart after a
 * change); a systemd service gets the one-click drop-in its plan command
 * builds, as the models folder does; a value in the app's own environment
 * wins and disables the field.
 */
function OllamaServiceEnvCard({
  setting: key,
  planCommand,
  choices,
  label,
  texts,
  restarting,
  onRestart,
}: {
  setting: SettingKey;
  planCommand: string;
  choices: readonly string[];
  /** The label of a value; null is Ollama's default. */
  label: (value: string | null) => string;
  texts: CardTexts;
  restarting: boolean;
  onRestart: () => void;
}) {
  const t = useT();
  const setting = useSettingsStore((s) => s.settings?.[key] ?? null);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const [plan, setPlan] = useState<OllamaServicePlan | null>(null);
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<OllamaServicePlan>(planCommand, { value: setting })
      .then((p) => {
        if (!cancelled) setPlan(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [planCommand, setting]);

  const options = [{ value: "", label: label(null) }, ...choices.map((c) => ({ value: c, label: label(c) }))];
  // A value set by hand in settings.json that is not a choice still shows.
  if (setting && !choices.includes(setting)) options.push({ value: setting, label: setting });

  const serviceDiffers = !!plan?.systemd && (plan.service_value ?? null) !== (setting || null);
  const applyToService = () => {
    if (!plan?.service_cmd) return;
    runInstallInTab(t(texts.applyTabLabel), plan.service_cmd, (plan.shell_kind || "bash") as InstallShellKind);
  };

  return (
    <SettingsCard>
      <div className="settings-subheader">
        {t(texts.title)} {texts.untested && <UntestedTag id={texts.untested} />}
      </div>
      <div className="ollama-path-row">
        <Dropdown
          value={setting ?? ""}
          options={options}
          disabled={!!plan?.env}
          ariaLabel={t(texts.title)}
          onChange={(v) => {
            setChanged(true);
            void updateSettings(patchOf(key, v === "" ? null : v));
          }}
        />
      </div>
      {plan?.env && <p className="settings-help">{t(texts.env, { value: plan.env })}</p>}
      {!plan?.env && plan?.systemd && (
        <>
          <p className="settings-help">{t(texts.service, { value: label(plan.service_value) })}</p>
          {serviceDiffers && plan.service_cmd && (
            <div className="ollama-install-cmd-row">
              <button type="button" className="ollama-action-btn primary" title={plan.service_cmd} onClick={applyToService}>
                {t(texts.apply)}
              </button>
            </div>
          )}
        </>
      )}
      {!plan?.env && plan && !plan.systemd && changed && (
        <div className="ollama-path-row">
          <span className="settings-help">{t(texts.pending)}</span>
          <button type="button" className="ollama-action-btn primary" disabled={restarting} onClick={onRestart}>
            {restarting ? t("localModel.restartingOllama") : t("localModel.restartOllama")}
          </button>
        </div>
      )}
      <p className="settings-help">{t(texts.help)}</p>
    </SettingsCard>
  );
}

const KEEP_ALIVE_CHOICES = ["30m", "1h", "-1"] as const;

/**
 * How long Ollama keeps a model loaded after its last request (`settings.
 * ollama_keep_alive`, `OLLAMA_KEEP_ALIVE`). Agents reach Ollama through its
 * OpenAI-compatible API, which cannot ask for longer per request, so an idle
 * local-model tab lost its model after Ollama's 5 minutes.
 */
export function OllamaKeepAliveCard({ restarting, onRestart }: { restarting: boolean; onRestart: () => void }) {
  const t = useT();
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
  return (
    <OllamaServiceEnvCard
      setting="ollama_keep_alive"
      planCommand="ollama_keep_alive_plan"
      choices={KEEP_ALIVE_CHOICES}
      label={label}
      texts={{
        title: "ollama.keepAliveTitle",
        env: "ollama.keepAliveEnv",
        service: "ollama.keepAliveService",
        apply: "ollama.keepAliveApply",
        applyTabLabel: "ollama.keepAliveApplyTabLabel",
        pending: "ollama.keepAlivePending",
        help: "ollama.keepAliveHelp",
        untested: "ollama.keepAliveTitle",
      }}
      restarting={restarting}
      onRestart={onRestart}
    />
  );
}

const KV_CACHE_CHOICES = ["q8_0", "q4_0"] as const;

/**
 * How Ollama stores a loaded model's context and the prompts it caches between
 * conversations (`settings.ollama_kv_cache_type`, `OLLAMA_KV_CACHE_TYPE` with
 * flash attention). At f16 its 8 GiB prompt cache holds two 40k-token
 * conversations, so two subagents of one tab evict each other and re-read
 * their prompts for minutes; q8_0 fits twice as many.
 */
export function OllamaKvCacheCard({ restarting, onRestart }: { restarting: boolean; onRestart: () => void }) {
  const t = useT();
  const label = (value: string | null): string => {
    switch (value) {
      case null:
      case "":
        return t("ollama.kvCacheDefault");
      case "q8_0":
        return t("ollama.kvCacheQ8");
      case "q4_0":
        return t("ollama.kvCacheQ4");
      default:
        return value;
    }
  };
  return (
    <OllamaServiceEnvCard
      setting="ollama_kv_cache_type"
      planCommand="ollama_kv_cache_plan"
      choices={KV_CACHE_CHOICES}
      label={label}
      texts={{
        title: "ollama.kvCacheTitle",
        env: "ollama.kvCacheEnv",
        service: "ollama.kvCacheService",
        apply: "ollama.kvCacheApply",
        applyTabLabel: "ollama.kvCacheApplyTabLabel",
        pending: "ollama.kvCachePending",
        help: "ollama.kvCacheHelp",
        untested: "ollama.kvCacheTitle",
      }}
      restarting={restarting}
      onRestart={onRestart}
    />
  );
}
