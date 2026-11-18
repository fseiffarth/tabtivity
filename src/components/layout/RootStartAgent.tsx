import { useT } from "../../lib/i18n";
import { AGENT_ITEMS, agentShortcutSlots, buildStaticTabSpec, itemLabel } from "../../lib/tabs/newTabItems";
import { ROOT_SCOPE, type TabEntry } from "../../stores/tabs";
import { UntestedTag } from "../common/UntestedTag";
import { useAddTabMenuData } from "../tabs/useAddTabMenuData";

/**
 * The empty Root card's primary action: "Start <default agent> in Root". The
 * same door as the `+` menu's first agent row and Ctrl+1 (`agentShortcutSlots`
 * on `useAddTabMenuData(ROOT_SCOPE)`, so only root-allowed agents count), one
 * click, no copy-it-yourself. With no root-allowed default agent it names the
 * switch instead (`overlayAgent.rootNotAllowed`, the overlays' own hint). Mounted
 * only on the empty card, so the agent probe runs only there.
 */
export function RootStartAgent({
  rootDir,
  onStart,
}: {
  rootDir: string;
  onStart: (spec: Omit<TabEntry, "key">) => void;
}) {
  const t = useT();
  const { enabledAgents, installedCustom, customAgents, defaultAgentBin, agentOrder } =
    useAddTabMenuData(ROOT_SCOPE);
  // Not probed yet: say nothing rather than guess "not allowed".
  if (enabledAgents === null) return null;
  const row = agentShortcutSlots({
    installedBuiltins: enabledAgents,
    installedCmds: installedCustom,
    customAgents,
    defaultAgentBin,
    agentOrder,
  })[0];
  if (!row) {
    const agent =
      AGENT_ITEMS.find((a) => a.cmd === defaultAgentBin)?.label ??
      customAgents.find((a) => a.cmd === defaultAgentBin)?.label ??
      defaultAgentBin;
    return <div className="center-placeholder-hint">{t("overlayAgent.rootNotAllowed", { agent })}</div>;
  }
  return (
    <button
      type="button"
      className="center-placeholder-action"
      onClick={() => onStart(buildStaticTabSpec(row.item, rootDir, "", t))}
    >
      {t("rootConsole.emptyStart", { agent: itemLabel(row.item, t) })}{" "}
      <UntestedTag id="rootConsole.emptyStart" />
    </button>
  );
}
