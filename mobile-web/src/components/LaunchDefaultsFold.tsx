import { useEffect, useState } from "react";
import { agentComposerKey, agentModelsFor } from "../../../src/lib/agents/agentPrefaces";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { ApiError, getLaunchDefaults, saveLaunchDefaults, type LaunchDefaults } from "../api";

const REFUSALS: Partial<Record<string, TranslationKey>> = {
  invalid_model: "agents.defaultsInvalidModel",
  effort_needs_model: "agents.defaultsEffortNeedsModel",
};

/**
 * Manage CLIs' "Default model and effort" for the tab's CLI, folded under the
 * model sheet's rows — the desktop Chat view's `ReaderLaunchDefaults`. The
 * rows change this session; this the model and effort new sessions of the CLI
 * start on (`GET`/`PUT /tabs/{id}/launch-defaults`). Nothing shows for a tab
 * the host has none for, or a CLI with no verified startup choice.
 */
export function LaunchDefaultsFold({ tabId, modelNames = [] }: { tabId: string; modelNames?: string[] }) {
  const t = useT();
  const [loaded, setLoaded] = useState<LaunchDefaults | null>(null);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    getLaunchDefaults(tabId).then((next) => {
      if (!live) return;
      setLoaded(next);
      setModel(next.saved.model);
      setEffort(next.saved.effort);
    }, () => {});
    return () => { live = false; };
  }, [tabId]);
  const cap = loaded?.capabilities;
  if (!loaded || !cap || (!cap.model && cap.efforts.length === 0)) return null;
  const { saved } = loaded;
  const configured = loaded.cli ? agentModelsFor(loaded.cli, loaded.models ? { [agentComposerKey(loaded.cli)]: loaded.models } : undefined) : [];
  const known = [...new Set([...configured, ...modelNames, ...(model ? [model] : [])])];
  const changed = model.trim() !== saved.model || effort !== saved.effort;
  const save = async (next: { model: string; effort: string }) => {
    setSaving(true);
    setError("");
    const kept = { model: next.model.trim(), effort: next.effort };
    try {
      await saveLaunchDefaults(tabId, kept);
      setLoaded({ ...loaded, saved: kept });
      setModel(kept.model);
      setEffort(kept.effort);
    } catch (err) {
      setError(t((err instanceof ApiError && REFUSALS[err.code]) || "mobile.model.defaultsFailed"));
    } finally {
      setSaving(false);
    }
  };
  const value = [saved.model, saved.effort].filter(Boolean).join(" · ") || t("terminal.reader.defaultsCli");
  return <details className="new-tab-held launch-defaults">
    <summary>{t("terminal.reader.defaultsTitle", { value })}{isUntested("mobile.model.launchDefaults") && <span className="untested">{t("mobile.focus.untested")}</span>}</summary>
    <p className="sheet-note">{t("terminal.reader.defaultsNote")}</p>
    <div className="launch-defaults-fields">
      {cap.model && <DefaultsDropdown label={t("agents.defaultModel")} value={model} values={known} disabled={saving} onChange={setModel} custom />}
      {cap.efforts.length > 0 && <DefaultsDropdown label={t("agents.defaultEffort")} value={effort} values={cap.efforts} disabled={saving} onChange={setEffort} />}
    </div>
    <div className="launch-defaults-actions">
      <button className="primary" disabled={saving || !changed} onClick={() => void save({ model, effort })}>{t("agents.defaultsSave")}</button>
      <button disabled={saving || (!saved.model && !saved.effort && !model && !effort)} onClick={() => void save({ model: "", effort: "" })}>{t("agents.defaultsReset")}</button>
    </div>
    {error && <p className="sheet-note error" role="alert">{error}</p>}
  </details>;
}

/** In-sheet choices inherit the phone theme rather than opening an OS picker. */
function DefaultsDropdown({ label, value, values, disabled, onChange, custom }: {
  label: string; value: string; values: string[]; disabled: boolean; custom?: boolean; onChange: (value: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return <div className="launch-defaults-field">
    <span>{label}</span>
    <button className="launch-defaults-trigger" aria-label={label} aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>
      <span>{value || t("agents.defaultsCli")}</span><span className="view-caret" aria-hidden="true" />
    </button>
    {open && custom && <input aria-label={label} value={value} maxLength={256} placeholder={t("agents.defaultsCli")} spellCheck={false} autoCapitalize="none" autoCorrect="off" disabled={disabled} onChange={(event) => onChange(event.target.value)} />}
    {open && <ul className="option-list launch-defaults-options" aria-label={label}>
      {["", ...values].map((entry) => <li key={entry}><button className={entry === value ? "current" : ""} aria-current={entry === value || undefined} disabled={disabled} onClick={() => { onChange(entry); setOpen(false); }}>
        <span>{entry || t("agents.defaultsCli")}</span>
      </button></li>)}
    </ul>}
  </div>;
}
