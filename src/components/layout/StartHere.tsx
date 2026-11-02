/**
 * The empty subwindow's own content: three starts with their live keys, the way
 * back to the agent last closed here, and the three doors to learn more. It
 * reads the shortcut table and never a key of its own, so a rebind shows here.
 *
 * The starts ask the subwindow's bar for a tab (`requestNewTab`), the same
 * request the chords make. An agent number with nothing behind it opens the +
 * menu instead, where the user can install or pick one.
 */
import { useSettingsStore } from "../../stores/settings";
import { reopenClosedAgentTab, useClosedAgentTabs } from "../../stores/agents/closedAgentTabs";
import { chordLabel, isUnbound, resolveChord, type ShortcutAction, type ShortcutMap } from "../../lib/shortcuts/shortcuts";
import { requestNewTab } from "../../lib/shortcuts/newTabChord";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";
import { FileTextIcon, SparkleIcon, TerminalIcon } from "../common/icons/Icon";
import { OPEN_PALETTE_EVENT } from "./CommandPalette";

function StartKey({ action, overrides }: { action: ShortcutAction; overrides: ShortcutMap | undefined }) {
  const chord = resolveChord(action, overrides);
  return isUnbound(chord) ? null : <kbd className="start-here-key">{chordLabel(chord)}</kbd>;
}

export function StartHere({ scope, groupId }: { scope: string; groupId: string }) {
  const t = useT();
  const overrides = useSettingsStore((s) => s.settings?.keyboard_shortcuts) as ShortcutMap | undefined;
  const last = useClosedAgentTabs(scope)[0];

  const startAgent = () => {
    if (!requestNewTab({ kind: "agent", slot: 0 }, { groupId })) requestNewTab({ kind: "menu" }, { groupId });
  };

  return (
    <div className="center-placeholder-card start-here">
      <h2 className="center-placeholder-title">{t("centerPanel.noTabsOpen")}</h2>
      <div className="start-here-starts">
        <button type="button" className="center-placeholder-action start-here-start" onClick={startAgent}>
          <SparkleIcon />
          <span>{t("startHere.agent")}</span>
          <StartKey action="agentTab1" overrides={overrides} />
        </button>
        <button
          type="button"
          className="center-placeholder-action start-here-start"
          onClick={() => requestNewTab({ kind: "shell" }, { groupId })}
        >
          <TerminalIcon />
          <span>{t("startHere.shell")}</span>
          <StartKey action="newShellTab" overrides={overrides} />
        </button>
        <button
          type="button"
          className="center-placeholder-action start-here-start"
          onClick={() => window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT, { detail: { filter: "#" } }))}
        >
          <FileTextIcon />
          <span>{t("startHere.file")}</span>
          <StartKey action="commandPalette" overrides={overrides} />
        </button>
      </div>
      {last && (
        <button type="button" className="start-here-last" onClick={() => reopenClosedAgentTab(scope, last.id)}>
          {t("startHere.lastTime", { label: last.tab.label })}
        </button>
      )}
      <div className="start-here-links">
        <button type="button" className="btn-quiet" onClick={() => window.dispatchEvent(new Event("app:open-how-to-start"))}>
          {t("startHere.tour")}
        </button>
        <button type="button" className="btn-quiet" onClick={() => window.dispatchEvent(new Event("app:open-shortcut-help"))}>
          {t("startHere.shortcuts")}
        </button>
        <button
          type="button"
          className="btn-quiet"
          onClick={() => window.dispatchEvent(new CustomEvent("app:open-settings", { detail: "help" }))}
        >
          {t("startHere.help")}
        </button>
        <UntestedTag id="desktop.startHere" />
      </div>
    </div>
  );
}
