import { isViewShown, useRootOverlayStore, useViewShown } from "../../stores/rootOverlay";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { AgentsGlyph } from "./HeaderGlyphs";

/**
 * The header's Agents button, in the global-apps run beside the cockpit and
 * Models: one click opens the console window on its Agents view (the agent CLIs
 * to install and set up, their plan and token usage, the skills library), a
 * second click while that view is shown closes the window again. It carries no
 * badge yet and starts no work of its own; the hover menus stay with Models
 * (`layout/LocalModelMenu`), whose doors open this view's sections.
 */
export function AgentsButton() {
  const t = useT();
  const shown = useViewShown("agents");
  const label = t("agents.headerButton");
  return (
    <div className="global-apps-menu agents-indicator no-drag">
      <button
        type="button"
        className="global-apps-menu-btn agents-indicator-btn"
        title={label}
        aria-label={label}
        aria-pressed={shown}
        onClick={() => {
          const overlay = useRootOverlayStore.getState();
          if (isViewShown("agents")) overlay.close();
          else overlay.openView("agents");
        }}
      >
        <AgentsGlyph className="agents-indicator-icon" />
      </button>
      <UntestedTag id="agents.headerButton" />
    </div>
  );
}
