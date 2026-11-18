import { useT } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settings";
import { UntestedTag } from "../common/UntestedTag";
import { ToggleRow } from "../layout/settingsUi";

export function CockpitMcpSettings() {
  const t = useT();
  const enabled = useSettingsStore((s) => s.settings?.cockpit_mcp ?? true);
  return <>
    <ToggleRow label={<>{t("cockpitMcp.title")} <UntestedTag id="cockpit.mcp.rename" /></>} checked={enabled}
      onChange={(e) => void useSettingsStore.getState().updateSettings({ cockpit_mcp: e.target.checked })} />
    <p className="settings-help">{t("cockpitMcp.help")}</p>
  </>;
}
