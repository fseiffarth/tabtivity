import { useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import { HelpGlyph } from "./HeaderGlyphs";
import { openHelpAgent } from "./helpAgent";
import { HelpAgentSetup, type HelpSetupPage } from "./HelpAgentSetup";

/**
 * The header's ? — ask an agent about the app. A click opens the default
 * agent as a "Help" tab in the root console (`openHelpAgent`: the floating
 * subwindow, so whatever was open stays put), primed to answer from the
 * built-in help server. With no agent CLI and no local model to open, it shows
 * how to get one instead (`HelpAgentSetup`): a cloud agent or a local model.
 *
 * Built as a header-button twin (`.global-apps-menu` > `.global-apps-menu-btn`,
 * the ✉ 🗓 ☑ chrome); it opens no menu, so it carries no hover-menu id.
 */
export function HelpAgentButton() {
  const t = useT();
  const [setup, setSetup] = useState<HelpSetupPage | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = () => {
    if (busy) return;
    setBusy(true);
    void openHelpAgent(t)
      .then((outcome) => {
        if (outcome === "none") setSetup("cloud");
        else if (outcome === "localFailed") setSetup("local");
      })
      .catch(() => setSetup("cloud"))
      .finally(() => setBusy(false));
  };

  return (
    <div className="global-apps-menu no-drag">
      <button
        type="button"
        className="global-apps-menu-btn help-agent-btn"
        data-hint-anchor="help-agent"
        title={t("helpAgent.button")}
        aria-label={t("helpAgent.button")}
        aria-busy={busy || undefined}
        onClick={ask}
      >
        <HelpGlyph className="help-agent-icon" />
      </button>
      {setup &&
        createPortal(
          <HelpAgentSetup initialPage={setup} onClose={() => setSetup(null)} />,
          document.body,
        )}
    </div>
  );
}
