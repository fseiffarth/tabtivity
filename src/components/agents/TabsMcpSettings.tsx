import { useState } from "react";
import { useT } from "../../lib/i18n";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { UntestedTag } from "../common/UntestedTag";
import { ToggleRow } from "../layout/settingsUi";

/** One project's idle-wake opt-in (`tab_messages_wake` in `projects.json`,
 *  off by default): a tab with new unread messages gets the host's fixed
 *  notice queued once it is idle, at most six times an hour. */
export function TabMessagesWakeToggle({ projectId }: { projectId: string }) {
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (!project) return null;
  return <>
    <ToggleRow label={project.name} checked={project.tab_messages_wake === true} disabled={busy}
      onChange={(e) => {
        setBusy(true);
        void useProjectsStore.getState().setProjectTabMessagesWake(projectId, e.target.checked)
          .then(() => setError("")).catch((err) => setError(String(err))).finally(() => setBusy(false));
      }} />
    {error && <small role="alert">{error}</small>}
  </>;
}

/** The on-by-default switch for tab messaging (`services::tabs_mcp`,
 *  `Settings::tabs_mcp`) in Manage CLIs, beside the print lane's. Off: new
 *  tabs get no `tabs_*` tools, and running tabs' calls answer `off`. On, the
 *  per-project idle wake lists below, each off until the user turns it on. */
export function TabsMcpSettings() {
  const t = useT();
  const enabled = useSettingsStore((s) => s.settings?.tabs_mcp ?? true);
  const projects = useProjectsStore((s) => s.projects);
  return <>
    <ToggleRow label={<>{t("tabsMcp.title")} <UntestedTag id="tabs.mcp.lane" /></>} checked={enabled}
      onChange={(e) => void useSettingsStore.getState().updateSettings({ tabs_mcp: e.target.checked })} />
    <p className="settings-help">{t("tabsMcp.help")}</p>
    {enabled && <>
      <p className="settings-help">{t("tabsMcp.wakeHelp")} <UntestedTag id="tabs.mcp.wake" /></p>
      {projects.filter((p) => !p.remote).map((p) => <TabMessagesWakeToggle key={p.id} projectId={p.id} />)}
    </>}
  </>;
}
