import { useT } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settings";
import { UntestedTag } from "../common/UntestedTag";
import { SettingRow, ToggleRow } from "../layout/settingsUi";
import { AgentsGroup } from "../settings/agentsUi";
import { AgentScheduleMcpSettings } from "./AgentScheduleMcpSettings";
import { CockpitMcpSettings } from "./CockpitMcpSettings";
import { GitPushMcpSettings } from "./GitPushMcp";
import { MarkupMcpSettings } from "./MarkupMcpSettings";
import { PrintMcpSettings } from "./PrintMcpSettings";

/** One visual home for the app's MCP lanes; each keeps its own authority. */
export function AppToolsSettings() {
  const t = useT();
  const helpEnabled = useSettingsStore((s) => s.settings?.help_mcp ?? true);
  const configure = (anchor: string) => window.dispatchEvent(new CustomEvent("app:open-settings", {
    detail: { panel: "main", anchor },
  }));
  return <AgentsGroup title={<>{t("agents.groupTools")} <UntestedTag id="agents.tools.group" /></>} summary={t("agents.sumTools")}>
    <p className="settings-help">{t("agents.tools.help")}</p>
    <div className="agents-stack">
      <div className="agents-option"><CockpitMcpSettings /></div>
      <div className="agents-option">
        <ToggleRow label={t("intro.ask.toggle")} checked={helpEnabled}
          onChange={(e) => void useSettingsStore.getState().updateSettings({ help_mcp: e.target.checked })} />
        <p className="settings-help">{t("intro.ask.reach")}</p>
      </div>
      <div className="agents-option"><AgentScheduleMcpSettings /></div>
      <div className="agents-option"><GitPushMcpSettings /></div>
      <div className="agents-option"><MarkupMcpSettings /></div>
      <div className="agents-option"><PrintMcpSettings /></div>
      <div className="agents-option">
        <SettingRow label={t("agents.tools.root")} help={t("agents.tools.rootHelp")} control={
          <button type="button" className="settings-btn sm" aria-label={t("agents.tools.root")} onClick={() => configure("settings-anchor-rootConsole")}>
            {t("agents.tools.configure")}
          </button>
        } />
        <SettingRow label={t("agents.tools.web")} help={t("agents.tools.webHelp")} control={
          <button type="button" className="settings-btn sm" aria-label={t("agents.tools.web")} onClick={() => configure("settings-anchor-assistant")}>
            {t("agents.tools.configure")}
          </button>
        } />
      </div>
    </div>
  </AgentsGroup>;
}
