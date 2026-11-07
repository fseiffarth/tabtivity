import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { UntestedTag } from "../common/UntestedTag";
import { Dropdown } from "../common/Dropdown";
import { useT } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settings";
import { agentModelsFor } from "../../lib/agents/agentPrefaces";
import type { AgentInfo } from "./agentTypes";
import type { Settings } from "../../types";

/** The latest saved defaults are read into this window's store when the form
 * opens and before it saves, so another window's save shows here and is kept. */
async function latestLaunchDefaults(): Promise<Settings["agent_launch_defaults"]> {
  const fresh = await invoke<Settings>("get_settings");
  useSettingsStore.setState((s) => (s.settings ? { settings: { ...s.settings, agent_launch_defaults: fresh.agent_launch_defaults } } : {}));
  return fresh.agent_launch_defaults;
}

/** Each installed CLI owns its defaults. Blank means the CLI decides.
 * `compact` (the Chat view's model and effort lists) leaves the help out. */
export function AgentDefaults({ agent, compact = false }: { agent: AgentInfo; compact?: boolean }) {
  const t = useT();
  const saved = useSettingsStore((s) => s.settings?.agent_launch_defaults?.[agent.bin]);
  const knownModels = useSettingsStore((s) => s.settings?.agent_models);
  const [draft, setDraft] = useState<{ model: string; effort: string } | null>(null);
  const model = draft?.model ?? saved?.model ?? "";
  const effort = draft?.effort ?? saved?.effort ?? "";
  const setModel = (value: string) => setDraft({ model: value, effort });
  const setEffort = (value: string) => setDraft({ model, effort: value });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { void latestLaunchDefaults().catch(() => {}); }, []);
  const cap = agent.launch_defaults;
  const invalidModel = model.trim().startsWith("-") || [...model].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  const changed = model.trim() !== (saved?.model ?? "") || effort !== (saved?.effort ?? "");
  const models = [...new Set([...(agent.default_models ?? []), ...agentModelsFor(agent.bin, knownModels)])];
  // Keep existing/custom IDs selectable even after a catalog update.
  const choices = model && !models.includes(model) ? [...models, model] : models;
  const save = async (reset = false) => {
    setSaving(true);
    setError("");
    if (!reset && (invalidModel || (effort && cap?.effort_requires_model && !model.trim()))) {
      setError(t(invalidModel ? "agents.defaultsInvalidModel" : "agents.defaultsEffortNeedsModel"));
      setSaving(false);
      return;
    }
    try {
      // Read at save time so editing a second card, or a phone, keeps its save.
      const store = useSettingsStore.getState();
      const defaults = { ...(await latestLaunchDefaults().catch(() => store.settings?.agent_launch_defaults)) };
      if (reset || (!model.trim() && !effort)) delete defaults[agent.bin];
      else defaults[agent.bin] = { model: model.trim(), effort };
      await store.updateSettings({ agent_launch_defaults: defaults });
      setDraft(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };
  if (!cap) return <p className="settings-help">{t("agents.defaultsBackend")}</p>;
  return (
    <div className={compact ? "agents-stack compact" : "agents-stack"}>
      {!compact && <p className="settings-help">{t("agents.defaultsHelp")}</p>}
      {cap.model ? (
        <>
          <div className="settings-card-row">
            <span>{t("agents.defaultModel")} <UntestedTag id="agents.defaultModelChoices" /></span>
            <Dropdown
              value={model}
              options={[{ value: "", label: t("agents.defaultsCli") }, ...choices.map((name) => ({ value: name, label: name }))]}
              ariaLabel={t("agents.defaultModel")}
              disabled={saving}
              onChange={setModel}
            />
          </div>
          {models.length === 0 && <p className="settings-help">{t("agents.defaultsNoModels")}</p>}
          <label className="settings-card-row">
            <span>{t("agents.defaultsCustomModel")}</span>
            <input
              type="text"
              aria-label={t("agents.defaultsCustomModel")}
              spellCheck={false}
              style={{ minWidth: 0, flex: 1 }}
              value={model}
              maxLength={256}
              disabled={saving}
              placeholder={t("agents.defaultsCli")}
              onChange={(e) => setModel(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && changed && !saving) void save(); }}
            />
          </label>
        </>
      ) : <p className="settings-help">{t("agents.defaultsModelUnavailable")}</p>}
      {cap.efforts.length > 0 ? (
        <div className="settings-card-row">
          <span>{t("agents.defaultEffort")}</span>
          <Dropdown
            value={effort}
            options={[{ value: "", label: t("agents.defaultsCli") }, ...cap.efforts.map((level) => ({ value: level, label: level }))]}
            ariaLabel={t("agents.defaultEffort")}
            disabled={saving}
            onChange={setEffort}
          />
        </div>
      ) : <p className="settings-help">{t("agents.defaultsEffortUnavailable")}</p>}
      {(cap.model || cap.efforts.length > 0) && (
        <>
          {!compact && <p className="settings-help">{t("agents.defaultsModelHelp")}</p>}
          <div className="settings-card-row">
            <button type="button" className="settings-btn sm primary" disabled={saving || !changed} onClick={() => void save()}>
              {t("agents.defaultsSave")}
            </button>
            <button type="button" className="settings-btn sm" disabled={saving || (!saved?.model && !saved?.effort && !model && !effort)} onClick={() => void save(true)}>
              {t("agents.defaultsReset")}
            </button>
          </div>
        </>
      )}
      {error && <p className="project-dialog-error" role="alert">{error}</p>}
    </div>
  );
}
