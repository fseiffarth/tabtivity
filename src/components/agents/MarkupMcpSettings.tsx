import { useT } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settings";
import { UntestedTag } from "../common/UntestedTag";
import { ToggleRow } from "../layout/settingsUi";

/** The on-by-default switch for the markup questions MCP
 * (`services::markup_mcp`, `Settings::markup_mcp`) in Manage CLIs, beside the
 * push lane's (`GitPushMcpSettings`). Off: new tabs get no `markup_ask`, and
 * running tabs' asks are refused as `off`. */
export function MarkupMcpSettings() {
  const t = useT();
  const enabled = useSettingsStore((s) => s.settings?.markup_mcp ?? true);
  return <>
    <ToggleRow label={<>{t("markupMcp.title")} <UntestedTag id="markupMcp" /></>} checked={enabled}
      onChange={(e) => void useSettingsStore.getState().updateSettings({ markup_mcp: e.target.checked })} />
    <p className="settings-help">{t("markupMcp.help")}</p>
  </>;
}
