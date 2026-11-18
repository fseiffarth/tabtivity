import { useT } from "../../lib/i18n";
import { runsLocally } from "../../stores/agents/agentClearUndo";
import { useActivityStore } from "../../stores/activity";
import type { TabEntry } from "../../stores/tabs";
import { ArrowRightIcon } from "../common/icons/Icon";
import { UntestedTag } from "../common/UntestedTag";

/** Which tabs can hand their work to another CLI: a local agent tab that is not
 * the assistant. Remote-host tabs, local-model tabs and the phone come later. */
export function canContinueInAnotherCli(scope: string, tab: TabEntry): boolean {
  return tab.kind === "agent" && !tab.assistant && runsLocally(scope, tab);
}

/**
 * The tab right-click menu's "Continue with another CLI…" row. It opens
 * `CliHandoffDialog`; it is disabled while the tab's own turn is running, since
 * the file would hold a half-finished turn. A shell command the agent started
 * (`shell` busy kind) is not a turn. Hidden for a tab that cannot hand off.
 */
export function CliHandoffMenuItem({ scope, tab, onOpen }: { scope: string; tab: TabEntry; onOpen: () => void }) {
  const t = useT();
  const ptyId = `${scope}:${tab.key}`;
  const working = useActivityStore((s) => !!s.busyByTab[ptyId] && s.busyKindByTab[ptyId] !== "shell");
  if (!canContinueInAnotherCli(scope, tab)) return null;
  return (
    <button
      className="tab-new-menu-item"
      disabled={working}
      title={t(working ? "cliHandoff.menuBusy" : "cliHandoff.menuTitle")}
      onClick={onOpen}
    >
      <span className="tab-new-menu-dot tab-new-menu-dot--accent"><ArrowRightIcon /></span>
      {t("cliHandoff.menu")}
      <UntestedTag id="agent.cliHandoff" />
    </button>
  );
}
