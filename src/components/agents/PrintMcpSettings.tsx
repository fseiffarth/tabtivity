import { useT } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settings";
import { UntestedTag } from "../common/UntestedTag";
import { ToggleRow } from "../layout/settingsUi";

/** The on-by-default switch for agent print requests (`services::print_mcp`,
 * `Settings::print_mcp`) in Manage CLIs, beside the markup lane's. Off: new
 * tabs get no `print_request`, and running tabs' requests are refused as
 * `off`. On, every print still waits for the user's Approve & print. */
export function PrintMcpSettings() {
  const t = useT();
  const enabled = useSettingsStore((s) => s.settings?.print_mcp ?? true);
  return <>
    <ToggleRow label={<>{t("printMcp.title")} <UntestedTag id="printMcp" /></>} checked={enabled}
      onChange={(e) => void useSettingsStore.getState().updateSettings({ print_mcp: e.target.checked })} />
    <p className="settings-help">{t("printMcp.help")}</p>
  </>;
}
