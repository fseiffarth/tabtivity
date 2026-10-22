import { setAiOff, useAiOff } from "../../lib/aiSwitch";
import { useT } from "../../lib/i18n";
import { RailPowerIcon } from "../common/EdgeRailIcons";
import { UntestedTag } from "../common/UntestedTag";

/**
 * The AI switch (`lib/aiSwitch.ts`) as the edge rail's bottom button: machine-wide,
 * so it rides the rail — present in every scope, open panel or closed — rather
 * than a project's header. Not a view tab: `data-rail-action="ai"` keeps the
 * rail's hover-open dwell off it.
 */
export function RailAiSwitch() {
  const t = useT();
  const aiOff = useAiOff();
  return (
    <button
      type="button"
      className={`side-panel-reveal-handle srh-ai${aiOff ? " off" : ""}`}
      data-rail-action="ai"
      onClick={() => void setAiOff(!aiOff)}
      aria-pressed={aiOff}
      aria-label={t("sidePanel.aiAria")}
      title={t(aiOff ? "sidePanel.aiOffTitle" : "sidePanel.aiOnTitle")}
    >
      <RailPowerIcon />
      <UntestedTag id="sidePanel.aiSwitch" />
    </button>
  );
}
