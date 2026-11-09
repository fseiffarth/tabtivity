import { useState } from "react";
import type { ProjectEntry } from "../../types";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { isCutNetwork, isLocalModelsOnly } from "../../lib/projects/localModelsOnly";
import { useT } from "../../lib/i18n";
import { DialogShell } from "../common/PromptDialogs";
import { UntestedTag } from "../common/UntestedTag";
import { IS_HOST_LINUX } from "../../lib/platform";
import { restartLocalTabs } from "../../stores/agents/restartLocalTabs";

/**
 * A project's agent privacy: Local models only (no cloud model reads the
 * project) and, beneath it, Cut network. The guarantee each switch gives is
 * said in its own words, with what it does not cover; the backend
 * (`services::agent_privacy`) enforces both on Linux, where the sandbox can cut the
 * network; elsewhere the Cut network switch is shown but cannot be turned on.
 * Changing Cut network leaves the project's running local tabs on the old
 * setting, so the dialog asks whether to restart them; it never does so itself.
 * Siblings: `CategoryEditor` (frame) and the Remote card of `ProjectDialog`
 * (the switch cards).
 */
export function AgentPrivacyDialog({ project, onClose }: { project: ProjectEntry; onClose: () => void }) {
  const t = useT();
  const setProjectAgentPrivacy = useProjectsStore((s) => s.setProjectAgentPrivacy);
  const [localOnly, setLocalOnly] = useState(() => isLocalModelsOnly(project));
  const [cut, setCut] = useState(() => isCutNetwork(project));
  // The running local tabs a saved change left on the other Cut network setting.
  const [restartTabs, setRestartTabs] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The agent tabs that turning the switch on ends: running cloud agents.
  const cloudTabs = useTabsStore(
    (s) => (s.tabsByScope[project.id] ?? []).filter((tab) => tab.kind === "agent").length,
  );
  const cutAvailable = IS_HOST_LINUX;
  const cutOn = localOnly && cut;
  const changed = localOnly !== isLocalModelsOnly(project) || cutOn !== (isLocalModelsOnly(project) && isCutNetwork(project));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const change = await setProjectAgentPrivacy(project.id, localOnly, cutOn);
      if (change.restart_tabs && change.restart_tabs.length > 0) {
        setRestartTabs(change.restart_tabs);
        setSaving(false);
        return;
      }
      onClose();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  const restart = async () => {
    setSaving(true);
    try {
      await restartLocalTabs(restartTabs ?? []);
    } finally {
      onClose();
    }
  };

  if (restartTabs) {
    return (
      <DialogShell
        frame="project-dialog"
        className="agent-privacy-dialog"
        title={<>{project.name} — {t("agentPrivacy.title")}</>}
        onDismiss={onClose}
      >
        <div className="project-dialog-path">
          {t(cutOn ? "agentPrivacy.restartCutOn" : "agentPrivacy.restartCutOff", { count: restartTabs.length })}
        </div>
        <div className="project-dialog-actions">
          <button type="button" onClick={onClose} disabled={saving}>{t("agentPrivacy.restartLater")}</button>
          <button type="button" onClick={() => void restart()} disabled={saving}>{t("agentPrivacy.restartNow")}</button>
        </div>
      </DialogShell>
    );
  }

  return (
    <DialogShell
      frame="project-dialog"
      className="agent-privacy-dialog"
      scroll
      title={<>{project.name} — {t("agentPrivacy.title")}</>}
      onDismiss={onClose}
    >
      <div className="project-dialog-path">{t("agentPrivacy.intro")}</div>

      <label className={`toggle-card${localOnly ? " is-on" : ""}`}>
        <span className="toggle-card-body">
          <span className="toggle-card-title">
            {t("agentPrivacy.localTitle")} <UntestedTag id="agentPrivacy.local" />
          </span>
          <span className="toggle-card-desc">{t("agentPrivacy.localDesc")}</span>
        </span>
        <span className="eld-switch">
          <input
            type="checkbox"
            checked={localOnly}
            disabled={saving}
            onChange={(e) => setLocalOnly(e.target.checked)}
          />
          <span className="eld-switch-track" aria-hidden="true" />
        </span>
      </label>

      <label className={`toggle-card${cutOn ? " is-on" : ""}`}>
        <span className="toggle-card-body">
          <span className="toggle-card-title">
            {t("agentPrivacy.cutTitle")} <UntestedTag id="agentPrivacy.cut" />
          </span>
          <span className="toggle-card-desc">{t("agentPrivacy.cutDesc")}</span>
          {cutAvailable ? (
            <span className="toggle-card-desc">{t("agentPrivacy.cutScope")}</span>
          ) : (
            <span className="toggle-card-desc">{t("agentPrivacy.cutNotYet")}</span>
          )}
        </span>
        <span className="eld-switch">
          {/* Switchable where the sandbox can cut the network (Linux), and only
              beneath Local models only. */}
          <input
            type="checkbox"
            checked={cutOn}
            disabled={saving || !cutAvailable || !localOnly}
            onChange={(e) => setCut(e.target.checked)}
          />
          <span className="eld-switch-track" aria-hidden="true" />
        </span>
      </label>

      <div className="project-dialog-path">{t("agentPrivacy.limits")}</div>
      {localOnly && !isLocalModelsOnly(project) && cloudTabs > 0 && (
        <div className="project-dialog-path">{t("agentPrivacy.closeNote", { count: cloudTabs })}</div>
      )}
      {error && <div className="project-dialog-error">{error}</div>}

      <div className="project-dialog-actions">
        <button type="button" onClick={onClose} disabled={saving}>{t("common.cancel")}</button>
        <button type="button" onClick={() => void save()} disabled={saving || !changed}>
          {saving ? t("agentPrivacy.saving") : t("agentPrivacy.save")}
        </button>
      </div>
    </DialogShell>
  );
}
